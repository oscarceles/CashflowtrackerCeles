/* =====================================================================
   STORAGE ADAPTER — único archivo que hay que tocar para cambiar backend
   ---------------------------------------------------------------------
   La app solo llama a estas 3 funciones:
     loadState()   -> devuelve el objeto de estado guardado, o null
     saveState(s)  -> guarda el objeto de estado
     clearState()  -> borra lo guardado (botón "Reset to Excel data")

   ▸ IMPLEMENTACIÓN ACTUAL: Supabase.
     Todo el equipo comparte los mismos datos (tabla app_state).
     Requiere la tabla creada en Supabase (ver README) y las variables
     VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY en .env.

   ▸ IMPLEMENTACIÓN ANTERIOR: localStorage (más abajo, comentada), útil
     para correr la app sin backend compartido.
   ===================================================================== */

import { supabase } from "./supabaseClient";

const KEY = "celes-cashflow-v1";

/* ------------------ IMPLEMENTACIÓN: Supabase ------------------ */

export async function loadState() {
  const { data, error } = await supabase
    .from("app_state").select("data").eq("id", KEY).maybeSingle();
  if (error) throw error;
  return data ? data.data : null;
}

export async function saveState(state) {
  const { error } = await supabase
    .from("app_state")
    .upsert({ id: KEY, data: state, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function clearState() {
  const { error } = await supabase.from("app_state").delete().eq("id", KEY);
  if (error) throw error;
}

/* ------------- IMPLEMENTACIÓN ANTERIOR: localStorage -------------

export async function loadState() {
  const raw = localStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export async function clearState() {
  localStorage.removeItem(KEY);
}

--------------------------------------------------------------------- */
