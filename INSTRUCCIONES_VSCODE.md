# Guía: abrir y trabajar este proyecto en Visual Studio Code

Es el mismo proyecto de la carpeta — no necesita ninguna conversión. Es un
proyecto Vite + React estándar, y VS Code lo abre tal cual.

## 1. Requisitos (una sola vez)

- **Node.js** (versión 18 o superior): descárgalo de https://nodejs.org
  (instala también `npm` automáticamente). Verifica en una terminal:
  ```bash
  node -v
  npm -v
  ```
- **Visual Studio Code**: https://code.visualstudio.com

## 2. Abrir el proyecto

1. Descomprime el ZIP.
2. En VS Code: **File → Open Folder…** y elige la carpeta `celes-cashflow-app`.
3. VS Code te sugerirá las extensiones recomendadas (Claude Code, Prettier,
   snippets de React) — acéptalas si quieres.

## 3. Correr la app en tu máquina

Abre la terminal integrada (**Terminal → New Terminal** o `` Ctrl+` ``) y ejecuta:

```bash
npm install     # solo la primera vez, instala dependencias
npm run dev     # inicia el servidor local
```

Abre http://localhost:5173 en el navegador. Cada cambio que guardes en el
código se refleja al instante (hot reload).

## 4. Dónde está cada cosa

| Archivo          | Qué contiene                                                        |
|------------------|---------------------------------------------------------------------|
| `src/App.jsx`    | Toda la app: vistas, motor de cálculo, generación de facturas       |
| `src/seed.js`    | Datos iniciales del Excel                                           |
| `src/storage.js` | **Único archivo a tocar** para pasar de localStorage a Supabase     |
| `README.md`      | Instrucciones de deploy y el prompt para el agente                  |

## 5. Hacerla multiusuario desde VS Code

El equivalente al agente de Antigravity dentro de VS Code es la extensión
**Claude Code** (recomendada en `.vscode/extensions.json`). Instálala, ábrela
y pégale el mismo prompt que está en el `README.md` (sección "Prompt sugerido
para el agente") — hará el trabajo: conectar Supabase siguiendo las
instrucciones de `src/storage.js`, agregar login, subir a GitHub y desplegar.

También puedes hacerlo a mano siguiendo los pasos comentados en la cabecera
de `src/storage.js`.

## 6. Deploy manual (sin agente)

```bash
npm run build   # genera la carpeta dist/ lista para producción
```

Luego, en Netlify o Vercel: importa el repo de GitHub (o arrastra la carpeta
`dist/` en Netlify Drop para una prueba rápida). Build command: `npm run build`,
publish directory: `dist`.

## Problemas comunes

- **"npm no se reconoce como comando"** → Node.js no está instalado o hay que
  reiniciar VS Code después de instalarlo.
- **El puerto 5173 está ocupado** → Vite elegirá otro automáticamente; mira la
  URL que imprime la terminal.
- **Pantalla en blanco tras el deploy** → revisa la consola del navegador
  (F12); casi siempre es una variable de entorno de Supabase faltante.
