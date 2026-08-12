// Supabase Edge Function: delete-account
// Marca la cuenta del usuario para eliminación diferida (soft-delete). No
// borra filas todavía: setea user_profiles.deleted_at y
// deletion_scheduled_for = now() + 30 días, y cierra la sesión. Un cron
// externo (documentado en docs/RUNBOOK_DEPLOY.md, aún pendiente) hace la
// purga real cuando llega la fecha.
//
// Requisitos:
// - JWT válido en Authorization: Bearer …
// - Migración 0006_soft_delete_accounts.sql ya aplicada.

/// <reference lib="deno.ns" />

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RETENTION_DAYS = 30;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const userId = userData.user.id;

  const now = new Date();
  const scheduled = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);

  try {
    const { error: updateErr } = await userClient
      .from('user_profiles')
      .update({
        deleted_at: now.toISOString(),
        deletion_scheduled_for: scheduled.toISOString(),
      })
      .eq('id', userId);

    if (updateErr) {
      return new Response(
        JSON.stringify({ error: 'Could not mark account for deletion', detail: updateErr.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Cierra la sesión actual y las demás del usuario. Requiere service role.
    // Si no está cargada la key, el marcado en DB ya se hizo y el cliente
    // igual va a llamar a auth.signOut() localmente.
    if (serviceRoleKey) {
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      try {
        await adminClient.auth.admin.signOut(userId, 'global');
      } catch (e) {
        console.warn('delete-account: admin.signOut failed (non-fatal):', e);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        deleted_at: now.toISOString(),
        deletion_scheduled_for: scheduled.toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
