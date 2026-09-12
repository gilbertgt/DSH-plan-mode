export const STYLE = `
.planx{padding:18px;max-width:1180px;color:inherit}
.planx h2,.planx h3{margin:.2rem 0 .8rem}
.planx-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.planx-tabs button,.planx button{padding:7px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;cursor:pointer}
.planx-tabs button[aria-selected="true"]{font-weight:700;outline:2px solid color-mix(in srgb,currentColor 35%,transparent)}
.planx-card{border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:12px;padding:14px;margin:10px 0;min-width:0}
.planx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}
.planx-muted{opacity:.72}.planx-error{border-left:3px solid currentColor;padding:8px;margin:8px 0}
.planx-chip{border-radius:999px!important;padding:4px 9px!important;white-space:nowrap}
.planx-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.planx-between{justify-content:space-between}
.planx label{display:grid;gap:4px;margin:8px 0}.planx input,.planx select{background:transparent;color:inherit;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:7px;padding:7px;min-width:0}
.planx input[type="checkbox"]{width:auto}.planx pre{white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
.planx-overlay{position:fixed;inset:0;background:rgba(0,0,0,.38);display:flex;justify-content:flex-end;z-index:9999}
.planx-dialog{width:min(720px,92vw);height:100%;overflow:auto;background:Canvas;color:CanvasText;padding:20px;box-shadow:0 0 30px rgba(0,0,0,.25)}
.planx-kv{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:6px 12px}.planx-kv>span:nth-child(odd){opacity:.72}
.planx progress{width:100%}
@media (prefers-color-scheme: dark){.planx-dialog{background:#161616;color:#f2f2f2}}
`
