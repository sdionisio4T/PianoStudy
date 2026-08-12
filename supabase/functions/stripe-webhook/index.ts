// Supabase Edge Function: stripe-webhook
// Esqueleto de Fase 3 — Stripe todavía NO está configurado. Esta función es
// segura de dejar desplegada tal cual: sin STRIPE_WEBHOOK_SECRET responde
// 500 a cualquier request y no toca la base de datos.
//
// TODO: conectar cuando se configure Stripe. Falta, en orden:
//   1. Crear el producto/precio del plan Premium en el Dashboard de Stripe.
//   2. Cargar STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET en Supabase Secrets
//      (Project Settings → Edge Functions → Secrets), igual que se hizo con
//      ANTHROPIC_API_KEY/GEMINI_API_KEY en la Fase 0.
//   3. Registrar este endpoint como webhook en el Dashboard de Stripe,
//      apuntando a la URL pública de esta función (Supabase te la da al
//      desplegarla), suscripto a los eventos manejados más abajo:
//      checkout.session.completed, customer.subscription.deleted,
//      invoice.payment_failed.
//   4. Implementar el flujo que crea el Checkout Session — eso NO es esta
//      función, es la tarea 3.6 "UI de upgrade/paywall" del roadmap
//      (docs/DIAGNOSTICO_Y_PLAN.md), todavía no construida. Ese flujo tiene que
//      pasar `client_reference_id: <supabase_user_id>` al crear la sesión de
//      Stripe — este webhook depende de ese dato para saber a qué usuario de
//      Supabase corresponde cada evento (ver el TODO puntual más abajo).

/// <reference lib="deno.ns" />

import Stripe from 'https://esm.sh/stripe@17?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

// Deno no soporta la verificación síncrona de firma de Stripe (la librería
// usa Node crypto internamente para eso) — se usa el crypto provider basado
// en SubtleCrypto que el SDK de Stripe expone específicamente para runtimes
// tipo Deno/edge, junto con `constructEventAsync`.
const cryptoProvider = Stripe.createSubtleCryptoProvider();

// El webhook lo llama Stripe directamente, no hay un usuario logueado ni JWT
// que verificar acá (a diferencia de anthropic-proxy/gemini-proxy). Se usa
// la service_role key porque este endpoint necesita poder actualizar el
// user_profiles de CUALQUIER usuario, bypasseando RLS.
function getSupabaseAdmin() {
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, serviceRoleKey);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const signature = req.headers.get('stripe-signature');
  const body = await req.text(); // el body crudo, NO parsear con .json() antes de verificar la firma

  // TODO: conectar cuando se configure Stripe (falta cargar STRIPE_WEBHOOK_SECRET).
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret || !signature) {
    return new Response(
      JSON.stringify({ error: 'Stripe webhook no configurado todavía (falta STRIPE_WEBHOOK_SECRET)' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined, cryptoProvider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Stripe signature verification failed:', message);
    return new Response(JSON.stringify({ error: `Webhook signature verification failed: ${message}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseAdmin = getSupabaseAdmin();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        // TODO: conectar cuando se configure Stripe. Requiere que el
        // Checkout Session se haya creado con client_reference_id igual al
        // id de usuario de Supabase (auth.users.id / user_profiles.id).
        const supabaseUserId = session.client_reference_id;
        if (!supabaseUserId) {
          console.error('checkout.session.completed sin client_reference_id — no se puede identificar el usuario, se ignora el evento');
          break;
        }

        // El período de la suscripción vive en el objeto Subscription, no en
        // el Checkout Session — hay que pedirlo aparte.
        let paidUntil: string | null = null;
        if (session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
          paidUntil = new Date(subscription.current_period_end * 1000).toISOString();
        }

        const { error } = await supabaseAdmin
          .from('user_profiles')
          .update({ plan: 'premium', paid_until: paidUntil })
          .eq('id', supabaseUserId);

        if (error) console.error('Error actualizando plan a premium:', error);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;

        // TODO: conectar cuando se configure Stripe. Mismo requisito que
        // checkout.session.completed — necesita poder mapear el
        // customer/subscription de Stripe a un usuario de Supabase. Acá se
        // asume que ese id se guardó en subscription.metadata al crear la
        // suscripción. Alternativa más robusta a evaluar: agregar una
        // columna stripe_customer_id a user_profiles (no incluida en esta
        // sesión) y buscar por esa columna en vez de depender de metadata.
        const supabaseUserId = subscription.metadata?.supabase_user_id;
        if (!supabaseUserId) {
          console.error('customer.subscription.deleted sin metadata.supabase_user_id — no se puede identificar el usuario, se ignora el evento');
          break;
        }

        const { error } = await supabaseAdmin
          .from('user_profiles')
          .update({ plan: 'free', paid_until: null })
          .eq('id', supabaseUserId);

        if (error) console.error('Error revirtiendo plan a free:', error);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;

        // TODO: conectar cuando se configure Stripe. Decisión de producto
        // pendiente de definir: ¿se revoca el acceso premium en el primer
        // fallo de cobro, o se da un período de gracia hasta que Stripe
        // reintente automáticamente (Stripe reintenta varias veces antes de
        // cancelar la suscripción)? Hoy este handler solo loguea el evento
        // — no cambia el plan del usuario. Definir la política de gracia
        // antes de activar este webhook en producción.
        console.warn('invoice.payment_failed recibido, sin acción automática (política de gracia pendiente de definir):', invoice.id);
        break;
      }

      default:
        // Evento de Stripe no manejado por este webhook — no es un error,
        // simplemente no nos interesa para la Fase 3 tal como está definida hoy.
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Error procesando webhook de Stripe:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
