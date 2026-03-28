/* =============================================================
   Pivot Suministros — Community Visualization para Looker Studio
   Versión 5.0
   Novedades respecto a v4:
     - ResizeObserver: fuentes y layout escalan dinámicamente
       cuando el usuario redimensiona el widget en el dashboard.
       Sin clamp(), sin media queries, sin fallbacks legacy.
     - Tooltips touch: en dispositivos táctiles (tablet/móvil)
       el tooltip aparece en touchstart y desaparece tras 2.5s
       o al tocar otra celda. Posicionamiento con e.touches[0].
   ============================================================= */

(function () {
  'use strict';

  /* ----------------------------------------------------------
     ESTADO GLOBAL
  ---------------------------------------------------------- */
  let expandedState  = {};
  let lastData       = null;
  let sortState      = null;
  let searchTerm     = '';
  let container      = null;
  let tooltipEl      = null;
  let globalTotals   = {};
  let resizeObserver = null;   // ResizeObserver activo
  let tooltipTimer   = null;   // Timer para auto-ocultar tooltip en touch
  let lastTouchCell  = null;   // Última celda tocada (para toggle en touch)

  /* ----------------------------------------------------------
     DETECCIÓN DE DISPOSITIVO TÁCTIL
     Se evalúa una vez al cargar — no cambia en runtime.
  ---------------------------------------------------------- */
  const IS_TOUCH = navigator.maxTouchPoints > 0;

  /* ----------------------------------------------------------
     ESCALA DE FUENTES DINÁMICA (ResizeObserver)
     Calcula el tamaño base a partir del ancho del contenedor.
     Rango: 10px (widget muy estrecho) — 14px (widget amplio).
     La escala es lineal entre 300px y 900px de ancho.
  ---------------------------------------------------------- */
  const FONT_MIN_PX   = 10;
  const FONT_MAX_PX   = 14;
  const WIDTH_MIN_PX  = 300;
  const WIDTH_MAX_PX  = 900;

  /**
   * Calcula el tamaño de fuente base en px según el ancho actual
   * del contenedor. El estilo del usuario (rowFontSize) actúa como
   * multiplicador máximo: si el usuario pide 12px y el widget es
   * pequeño, se escala proporcionalmente hacia abajo.
   */
  function computeFontSize(containerWidth, userFontSize) {
    const user = Math.max(8, Math.min(20, parseInt(userFontSize, 10) || 12));
    // Ratio de escala: 0 en WIDTH_MIN, 1 en WIDTH_MAX
    const ratio = Math.min(1, Math.max(0,
      (containerWidth - WIDTH_MIN_PX) / (WIDTH_MAX_PX - WIDTH_MIN_PX)
    ));
    // Interpolar entre FONT_MIN y user (el máximo lo fija el usuario)
    const scaled = FONT_MIN_PX + ratio * (user - FONT_MIN_PX);
    return Math.round(scaled * 10) / 10; // 1 decimal
  }

  /**
   * Calcula el ancho de la columna de dimensiones proporcional
   * al contenedor. El usuario define el valor base (defaultValue 220).
   */
  function computeDimColWidth(containerWidth, userWidth) {
    const user = Math.max(120, Math.min(500, parseInt(userWidth, 10) || 220));
    // Reducir proporcionalmente si el contenedor es estrecho
    if (containerWidth < WIDTH_MIN_PX) return Math.max(100, user * 0.6);
    if (containerWidth < 600) return Math.max(120, user * 0.8);
    return user;
  }

  /* ----------------------------------------------------------
     UTILIDADES DE ESTILO
  ---------------------------------------------------------- */
  function getStyle(style, key, fallback) {
    try {
      const v = style[key] && style[key].value;
      return (v !== undefined && v !== null && v !== '') ? v : fallback;
    } catch (_) { return fallback; }
  }

  function getThemeColors() {
    try {
      const t = dscc.getTheme ? dscc.getTheme() : null;
      if (!t) return {};
      return {
        themePrimary:   t.themeFillColor    || '#1a3a5c',
        themeOnPrimary: t.themeTextColor    || '#ffffff',
        themeSurface:   t.themeSurfaceColor || '#ffffff',
        themeOnSurface: t.themeTextColor    || '#2d2d2d',
      };
    } catch (_) { return {}; }
  }

  /* ----------------------------------------------------------
     PARSEO DE CAMPOS (P3: pivote por convención = última dim)
  ---------------------------------------------------------- */
  function parseFields(data, pivotDimOverride) {
    const allFields     = data.fields.concepts || [];
    const dimFields     = allFields.filter(f => f.type === 'DIMENSION');
    const metricFields  = allFields.filter(f => f.type === 'METRIC');
    let pivotIdx;
    if (!pivotDimOverride || pivotDimOverride === 'auto') {
      pivotIdx = dimFields.length - 1;
    } else {
      const p = parseInt(pivotDimOverride, 10);
      pivotIdx = isNaN(p) ? dimFields.length - 1 : Math.min(p, dimFields.length - 1);
    }
    return {
      hierDimFields:  dimFields.filter((_, i) => i !== pivotIdx),
      pivotField:     dimFields[pivotIdx],
      metricFields,
    };
  }

  function getVal(row, fieldId) {
    const v = row[fieldId];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  }

  /* ----------------------------------------------------------
     FORMATEADORES POR MÉTRICA (P4: hereda config de Looker)
  ---------------------------------------------------------- */
  function buildFormatters(metricFields, nullHandling) {
    const locale = navigator.language || 'es-ES';
    const map    = new Map();
    metricFields.forEach(mf => {
      const cfg          = mf.config || {};
      const currencyCode = cfg.currencyCode || extractCurrency(cfg.format);
      const isPercent    = cfg.semantics
        ? /PERCENT/.test(cfg.semantics.semanticType || '')
        : /PERCENT/.test(cfg.format || '');
      let fmt;
      if (currencyCode) {
        try {
          fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode,
            minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } catch (_) {
          fmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
      } else if (isPercent) {
        fmt = new Intl.NumberFormat(locale, { style: 'percent',
          minimumFractionDigits: 1, maximumFractionDigits: 2 });
      } else {
        fmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      map.set(mf.id, (value) => {
        if (value === null || value === undefined || value === '') {
          if (nullHandling === 'null')  return '—';
          if (nullHandling === 'blank') return '';
          return fmt.format(0);
        }
        const n = Number(value);
        return isNaN(n) ? String(value) : fmt.format(n);
      });
    });
    return map;
  }

  function extractCurrency(formatStr) {
    const m = String(formatStr || '').match(/CURRENCY_([A-Z]{3})/);
    return m ? m[1] : null;
  }

  /* ----------------------------------------------------------
     JERARQUÍA Y ACUMULACIÓN (P1: nulos configurables)
  ---------------------------------------------------------- */
  function buildHierarchy(rows, hierDimFields, pivotField, metricFields, nullHandling) {
    const root = { children: new Map(), totals: new Map() };
    rows.forEach(row => {
      const pivotVal = String(getVal(row, pivotField.id) ?? '');
      const metVals  = {};
      metricFields.forEach(mf => {
        const raw = getVal(row, mf.id);
        metVals[mf.id] = (raw === null || raw === undefined) ? null : raw;
      });
      let node = root;
      hierDimFields.forEach(df => {
        const key = String(getVal(row, df.id) ?? '(vacío)');
        if (!node.children.has(key)) node.children.set(key, { children: new Map(), totals: new Map() });
        node = node.children.get(key);
        acumular(node.totals, pivotVal, metVals, metricFields, nullHandling);
      });
      acumular(root.totals, pivotVal, metVals, metricFields, nullHandling);
    });
    return root;
  }

  function acumular(map, pivotVal, metVals, metricFields, nullHandling) {
    if (!map.has(pivotVal)) {
      const init = {};
      metricFields.forEach(mf => { init[mf.id] = nullHandling === 'zero' ? 0 : null; });
      map.set(pivotVal, init);
    }
    const t = map.get(pivotVal);
    metricFields.forEach(mf => {
      const raw = metVals[mf.id];
      if (raw === null || raw === undefined) {
        if (nullHandling === 'zero') t[mf.id] = (t[mf.id] ?? 0) + 0;
      } else {
        const n = Number(raw);
        if (!isNaN(n)) t[mf.id] = (t[mf.id] ?? 0) + n;
      }
    });
  }

  function getPivotValues(root) {
    return Array.from(root.totals.keys()).sort();
  }

  function computeGlobalTotals(root, pivotValues, metricFields) {
    globalTotals = {};
    pivotValues.forEach(pv => {
      const vals = root.totals.get(pv) || {};
      metricFields.forEach(mf => { globalTotals[`${pv}||${mf.id}`] = vals[mf.id] ?? null; });
    });
    metricFields.forEach(mf => {
      let sum = null;
      pivotValues.forEach(pv => {
        const v = root.totals.get(pv)?.[mf.id] ?? null;
        if (v !== null) sum = (sum ?? 0) + v;
      });
      globalTotals[`__rowtotal__||${mf.id}`] = sum;
    });
  }

  function applySortToRoot(root) {
    if (!sortState) return root;
    const { pivotVal, metricId, asc } = sortState;
    const entries = Array.from(root.children.entries());
    entries.sort(([, a], [, b]) => {
      const va = a.totals.get(pivotVal)?.[metricId] ?? -Infinity;
      const vb = b.totals.get(pivotVal)?.[metricId] ?? -Infinity;
      return asc ? va - vb : vb - va;
    });
    root.children = new Map(entries);
    return root;
  }

  /* ----------------------------------------------------------
     HELPERS DE JERARQUÍA
  ---------------------------------------------------------- */
  function isAncestorChainExpanded(parentPath) {
    if (!parentPath) return true;
    const parts = parentPath.split('||');
    for (let i = 1; i <= parts.length; i++) {
      if (expandedState[parts.slice(0, i).join('||')] === false) return false;
    }
    return expandedState[parentPath] !== false;
  }

  function getAncestorPaths(path) {
    const parts = path.split('||');
    return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('||'));
  }

  /* ----------------------------------------------------------
     CSS DINÁMICO — recibe tamaños ya calculados por ResizeObserver
  ---------------------------------------------------------- */
  function injectStyles(style, fontSize, dimColWidth) {
    const th = getThemeColors();
    const headerBg    = getStyle(style, 'headerBg',       th.themePrimary   || '#1a3a5c');
    const headerText  = getStyle(style, 'headerText',     th.themeOnPrimary || '#ffffff');
    // headerFontSize escala igual que rowFontSize pero puede ser mayor
    const headerFontSzUser = parseInt(getStyle(style, 'headerFontSize', '12'), 10);
    const headerFontSz     = fontSize * (headerFontSzUser / 12); // ratio respecto al base 12
    const rowOddBg    = getStyle(style, 'rowOddBg',       th.themeSurface   || '#ffffff');
    const rowEvenBg   = getStyle(style, 'rowEvenBg',      '#f2f6fa');
    const rowText     = getStyle(style, 'rowText',        th.themeOnSurface || '#2d2d2d');
    const level1Bg    = getStyle(style, 'level1Bg',       '#dce8f5');
    const level2Bg    = getStyle(style, 'level2Bg',       '#eef4fb');
    const level3Bg    = getStyle(style, 'level3Bg',       '#f7fafd');
    const subtotalBg  = getStyle(style, 'subtotalBg',     '#e8f0f8');
    const totalBg     = getStyle(style, 'totalBg',        '#c8ddf0');
    const totalText   = getStyle(style, 'totalText',      '#1a3a5c');
    const metricAlign = getStyle(style, 'metricAlign',    'right');
    const showBorder  = getStyle(style, 'showGroupBorder','true') === 'true';
    const rowTotPos   = getStyle(style, 'rowTotalsPosition', 'sticky');
    const groupBorder = showBorder ? '2px solid rgba(0,0,0,0.12)' : 'none';

    // Padding de celda escala con la fuente
    const cellPadV = Math.round(fontSize * 0.4);
    const cellPadH = Math.round(fontSize * 0.8);

    const css = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: "Google Sans", Arial, sans-serif; overflow: hidden; background: transparent; }

      #pv-toolbar {
        display: flex; align-items: center; gap: 8px;
        padding: ${cellPadV}px 8px;
        border-bottom: 1px solid rgba(0,0,0,0.08); flex-shrink: 0;
      }
      #pv-search {
        flex: 1; max-width: 220px; height: ${Math.round(fontSize * 2.2)}px;
        padding: 0 8px; font-size: ${Math.round(fontSize * 0.92)}px;
        border: 1px solid rgba(0,0,0,0.2); border-radius: 4px;
        background: white; color: #333; outline: none;
      }
      #pv-search:focus { border-color: ${headerBg}; }
      #pv-search::placeholder { color: #aaa; }
      .pv-btn {
        height: ${Math.round(fontSize * 2.2)}px; padding: 0 10px;
        font-size: ${Math.round(fontSize * 0.85)}px; cursor: pointer;
        border: 1px solid rgba(0,0,0,0.18); border-radius: 4px;
        background: white; color: #444; white-space: nowrap;
        /* Área táctil mínima recomendada 44px en touch */
        min-height: ${IS_TOUCH ? '44px' : 'auto'};
      }
      .pv-btn:hover { background: #f0f4f8; }

      #pv-wrap   { display: flex; flex-direction: column; width: 100%; height: 100vh; overflow: hidden; }
      #pv-scroll { flex: 1; overflow: auto; position: relative;
                   /* Scroll suave en iOS */
                   -webkit-overflow-scrolling: touch; }

      table {
        border-collapse: separate; border-spacing: 0;
        font-size: ${fontSize}px; color: ${rowText};
        width: max-content; min-width: 100%;
      }

      thead th {
        background: ${headerBg}; color: ${headerText};
        font-size: ${Math.round(headerFontSz * 10) / 10}px; font-weight: 600;
        padding: ${cellPadV}px ${cellPadH}px; white-space: nowrap;
        position: sticky; top: 0; z-index: 3;
        border-bottom: 2px solid rgba(255,255,255,0.2); user-select: none;
        /* Área táctil mínima en touch */
        ${IS_TOUCH ? `min-height: 44px;` : ''}
      }
      thead tr.row-pivot-group th {
        text-align: center; font-weight: 700; letter-spacing: 0.03em;
        border-bottom: 1px solid rgba(255,255,255,0.15);
      }
      thead th.dim-col {
        left: 0; z-index: 4;
        width: ${dimColWidth}px; min-width: ${dimColWidth}px; max-width: ${dimColWidth}px;
        border-right: 2px solid rgba(255,255,255,0.25);
      }
      thead th.tot-col-sticky {
        right: 0; z-index: 4;
        border-left: 2px solid rgba(255,255,255,0.25);
        background: ${headerBg}; text-align: center;
      }
      thead th.met-col { cursor: pointer; text-align: ${metricAlign}; }
      thead th.met-col:hover { filter: brightness(1.18); }
      thead th.met-col.s-asc::after  { content: ' ▲'; font-size: ${Math.round(fontSize * 0.72)}px; }
      thead th.met-col.s-desc::after { content: ' ▼'; font-size: ${Math.round(fontSize * 0.72)}px; }
      thead th.grp-start, tbody td.grp-start { border-left: ${groupBorder}; }

      tbody td {
        padding: ${cellPadV}px ${cellPadH}px; white-space: nowrap;
        border-bottom: 1px solid #e0e8f0; vertical-align: middle;
      }
      tbody td.dim-col {
        position: sticky; left: 0; z-index: 2;
        width: ${dimColWidth}px; min-width: ${dimColWidth}px; max-width: ${dimColWidth}px;
        border-right: 2px solid #c0d4e8; overflow: hidden; text-overflow: ellipsis;
      }
      tbody td.met-val  { text-align: ${metricAlign}; font-variant-numeric: tabular-nums; }
      tbody td.tot-col-sticky {
        position: sticky; right: 0; z-index: 2;
        border-left: 2px solid #c0d4e8;
        text-align: ${metricAlign}; font-variant-numeric: tabular-nums; background: inherit;
      }

      tbody tr[data-level="0"] td { background: ${level1Bg} !important; font-weight: 700; }
      tbody tr[data-level="1"] td { background: ${level2Bg} !important; font-weight: 600; }
      tbody tr[data-level="2"] td { background: ${level3Bg} !important; font-weight: 500; }
      tbody tr.leaf.odd  td { background: ${rowOddBg}; }
      tbody tr.leaf.even td { background: ${rowEvenBg}; }
      tbody tr.subtotal-row td {
        background: ${subtotalBg} !important; font-weight: 600; font-style: italic;
        border-top: 1px solid rgba(0,0,0,0.08);
      }
      tbody tr.total-row td {
        background: ${totalBg} !important; color: ${totalText};
        font-weight: 700; font-style: italic; border-top: 2px solid rgba(0,0,0,0.12);
      }

      tr.pv-hidden   { display: none !important; }
      tr.pv-filtered { display: none !important; }

      .dim-label  { display: inline-flex; align-items: center; gap: 5px; }
      .toggle-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: ${Math.round(fontSize * 1.2)}px; height: ${Math.round(fontSize * 1.2)}px;
        font-size: ${Math.round(fontSize * 0.72)}px; flex-shrink: 0;
        cursor: pointer; border: 1px solid currentColor; border-radius: 3px; opacity: 0.6;
        /* Área táctil ampliada en touch */
        ${IS_TOUCH ? `min-width: 36px; min-height: 36px;` : ''}
      }
      .toggle-btn:hover { opacity: 1; }
      .spacer {
        display: inline-block;
        width: ${Math.round(fontSize * 1.2)}px;
        ${IS_TOUCH ? `min-width: 36px;` : ''}
        flex-shrink: 0;
      }

      /* ── Tooltip ── */
      #pv-tooltip {
        position: fixed; z-index: 9999; pointer-events: none;
        background: rgba(30,40,60,0.93); color: #fff;
        font-size: ${Math.max(10, Math.round(fontSize * 0.9))}px;
        padding: ${cellPadV + 2}px ${cellPadH}px;
        border-radius: 5px; white-space: nowrap; display: none; line-height: 1.7;
        box-shadow: 0 2px 8px rgba(0,0,0,0.28);
        /* En touch: más grande y sin flecha de cursor */
        ${IS_TOUCH ? `font-size: ${Math.max(12, Math.round(fontSize))}px; padding: 10px 14px;` : ''}
      }
    `;

    let el = document.getElementById('pv-style');
    if (!el) { el = document.createElement('style'); el.id = 'pv-style'; document.head.appendChild(el); }
    el.textContent = css;
  }

  /* ----------------------------------------------------------
     GENERACIÓN DE FILAS HTML
  ---------------------------------------------------------- */
  function metCell(v, mf, pivotLabel, formatters, isFirst, isGrpStart) {
    const fmt  = formatters.get(mf.id);
    const disp = fmt ? fmt(v) : (v === null ? '—' : v);
    const gt   = globalTotals[`${pivotLabel}||${mf.id}`];
    const pct  = (gt !== null && gt !== 0 && v !== null)
      ? ((v / gt) * 100).toFixed(1) : 'n/a';
    const cls  = 'met-val' + (isGrpStart && isFirst ? ' grp-start' : '');
    return {
      html: `<td class="${cls}" data-val="${esc(v === null ? '' : String(v))}" ` +
            `data-pct="${pct}" data-fid="${esc(mf.id)}" ` +
            `data-label="${esc(mf.name)} / ${esc(pivotLabel)}">${disp}</td>`,
      val: v,
    };
  }

  function buildRows(node, hierDimFields, pivotValues, metricFields,
                     level, parentPath, leafCounter, style, formatters) {
    const rows        = [];
    const showSub     = getStyle(style, 'showSubtotals',     'true') === 'true';
    const showRowTot  = getStyle(style, 'showRowTotals',     'true') === 'true';
    const rowTotPos   = getStyle(style, 'rowTotalsPosition', 'sticky');
    const isLastLevel = level === hierDimFields.length - 1;

    node.children.forEach((childNode, key) => {
      const path        = parentPath ? `${parentPath}||${key}` : key;
      const isLeaf      = isLastLevel;
      const hasChildren = childNode.children.size > 0;
      const isExpanded  = expandedState[path] !== false;
      const hidden      = !isAncestorChainExpanded(parentPath);
      const indentPx    = 8 + level * 18;

      // Celda dimensión
      let dimCell = `<td class="dim-col" style="padding-left:${indentPx}px"><span class="dim-label">`;
      dimCell += hasChildren
        ? `<span class="toggle-btn" data-path="${esc(path)}">${isExpanded ? '▾' : '▸'}</span>`
        : `<span class="spacer"></span>`;
      dimCell += `${esc(key)}</span></td>`;

      // Celdas métricas
      let metCells = '';
      const rowTotAcc = {};
      metricFields.forEach(mf => { rowTotAcc[mf.id] = null; });

      pivotValues.forEach((pv, pi) => {
        const vals = childNode.totals.get(pv) || {};
        metricFields.forEach((mf, mi) => {
          const v = vals[mf.id] ?? null;
          if (v !== null) rowTotAcc[mf.id] = (rowTotAcc[mf.id] ?? 0) + v;
          const { html } = metCell(v, mf, pv, formatters, mi === 0, pi > 0);
          metCells += html;
        });
      });

      // Total de fila
      let rowTotCell = '';
      if (showRowTot) {
        const sc = rowTotPos === 'sticky' ? ' tot-col-sticky' : '';
        metricFields.forEach(mf => {
          const v   = rowTotAcc[mf.id];
          const fmt = formatters.get(mf.id);
          const disp = fmt ? fmt(v) : (v === null ? '—' : v);
          const gt  = globalTotals[`__rowtotal__||${mf.id}`];
          const pct = (gt !== null && gt !== 0 && v !== null)
            ? ((v / gt) * 100).toFixed(1) : 'n/a';
          rowTotCell += `<td class="met-val${sc}" data-val="${esc(v === null ? '' : String(v))}" ` +
            `data-pct="${pct}" data-fid="${esc(mf.id)}" data-label="Total ${esc(mf.name)}">${disp}</td>`;
        });
      }

      const leafClass = isLeaf ? ` leaf ${leafCounter.n % 2 === 0 ? 'odd' : 'even'}` : '';
      if (isLeaf) leafCounter.n++;

      rows.push(
        `<tr data-level="${level}" class="${leafClass}${hidden ? ' pv-hidden' : ''}" ` +
        `data-path="${esc(path)}" data-parent="${esc(parentPath || '')}" data-label="${esc(key)}">` +
        `${dimCell}${metCells}${rowTotCell}</tr>`
      );

      if (hasChildren) {
        rows.push(...buildRows(childNode, hierDimFields, pivotValues, metricFields,
          level + 1, path, leafCounter, style, formatters));

        // Subtotal
        if (showSub && !isLeaf) {
          const subHidden = hidden || !isExpanded;
          let subMet = '', subRowTot = '';
          const subAcc = {};
          metricFields.forEach(mf => { subAcc[mf.id] = null; });

          pivotValues.forEach((pv, pi) => {
            const vals = childNode.totals.get(pv) || {};
            metricFields.forEach((mf, mi) => {
              const v = vals[mf.id] ?? null;
              if (v !== null) subAcc[mf.id] = (subAcc[mf.id] ?? 0) + v;
              const { html } = metCell(v, mf, pv, formatters, mi === 0, pi > 0);
              subMet += html;
            });
          });

          if (showRowTot) {
            const sc = rowTotPos === 'sticky' ? ' tot-col-sticky' : '';
            metricFields.forEach(mf => {
              const v    = subAcc[mf.id];
              const fmt  = formatters.get(mf.id);
              const disp = fmt ? fmt(v) : (v === null ? '—' : v);
              const gt   = globalTotals[`__rowtotal__||${mf.id}`];
              const pct  = (gt !== null && gt !== 0 && v !== null)
                ? ((v / gt) * 100).toFixed(1) : 'n/a';
              subRowTot += `<td class="met-val${sc}" data-val="${esc(v === null ? '' : String(v))}" ` +
                `data-pct="${pct}" data-fid="${esc(mf.id)}" data-label="Subtotal Total ${esc(mf.name)}">${disp}</td>`;
            });
          }

          rows.push(
            `<tr class="subtotal-row${subHidden ? ' pv-hidden' : ''}" ` +
            `data-path="${esc(path)}__sub" data-parent="${esc(path)}" data-label="Subtotal ${esc(key)}">` +
            `<td class="dim-col" style="padding-left:${indentPx + 4}px">` +
            `<span class="dim-label"><span class="spacer"></span>Subtotal ${esc(key)}</span></td>` +
            `${subMet}${subRowTot}</tr>`
          );
        }
      }
    });
    return rows;
  }

  /* ----------------------------------------------------------
     RENDER PRINCIPAL
     Calcula fontSize y dimColWidth desde el contenedor actual
     antes de inyectar estilos y generar HTML.
  ---------------------------------------------------------- */
  function render(data) {
    lastData = data;
    const { style } = data;

    const pivotDimOverride = getStyle(style, 'pivotDimOverride',  'auto');
    const showColTotals    = getStyle(style, 'showColTotals',     'true') === 'true';
    const showRowTotals    = getStyle(style, 'showRowTotals',     'true') === 'true';
    const rowTotPos        = getStyle(style, 'rowTotalsPosition', 'sticky');
    const nullHandling     = getStyle(style, 'nullHandling',      'zero');
    const userFontSize     = getStyle(style, 'rowFontSize',       '12');
    const userDimColWidth  = getStyle(style, 'dimColWidth',       '220');

    const { hierDimFields, pivotField, metricFields } = parseFields(data, pivotDimOverride);

    const wrap = getOrCreateWrap();

    if (!pivotField || metricFields.length === 0) {
      wrap.querySelector('#pv-scroll').innerHTML =
        '<p style="padding:20px;color:#888">Añade al menos 2 dimensiones y 1 métrica.</p>';
      return;
    }

    // Leer tamaño actual del contenedor para escalar fuentes
    const containerWidth = wrap.offsetWidth || window.innerWidth;
    const fontSize       = computeFontSize(containerWidth, userFontSize);
    const dimColWidth    = computeDimColWidth(containerWidth, userDimColWidth);

    injectStyles(style, fontSize, dimColWidth);

    const rows = data.tables.DEFAULT.rows;
    if (!rows || rows.length === 0) {
      wrap.querySelector('#pv-scroll').innerHTML =
        '<p style="padding:20px;color:#888">Sin datos.</p>';
      return;
    }

    const formatters  = buildFormatters(metricFields, nullHandling);
    let   root        = buildHierarchy(rows, hierDimFields, pivotField, metricFields, nullHandling);
    root              = applySortToRoot(root);
    const pivotValues = getPivotValues(root);
    computeGlobalTotals(root, pivotValues, metricFields);

    // ── CABECERA ──
    let headHtml = '<thead><tr class="row-pivot-group">';
    headHtml += `<th class="dim-col" rowspan="2">Dimensiones</th>`;
    pivotValues.forEach((pv, pi) => {
      headHtml += `<th colspan="${metricFields.length}"${pi > 0 ? ' class="grp-start"' : ''}>${esc(pv)}</th>`;
    });
    if (showRowTotals) {
      const sc = rowTotPos === 'sticky' ? ' class="tot-col-sticky"' : '';
      headHtml += `<th colspan="${metricFields.length}"${sc}>Total fila</th>`;
    }
    headHtml += '</tr><tr>';
    pivotValues.forEach((pv, pi) => {
      metricFields.forEach((mf, mi) => {
        let cls = 'met-col';
        if (mi === 0 && pi > 0) cls += ' grp-start';
        if (sortState && sortState.pivotVal === pv && sortState.metricId === mf.id)
          cls += sortState.asc ? ' s-asc' : ' s-desc';
        headHtml += `<th class="${cls}" data-pv="${esc(pv)}" data-mid="${esc(mf.id)}">${esc(mf.name)}</th>`;
      });
    });
    if (showRowTotals) {
      const sc = rowTotPos === 'sticky' ? ' tot-col-sticky' : '';
      metricFields.forEach(mf => {
        headHtml += `<th class="met-col${sc ? ' ' + sc : ''}">${esc(mf.name)}</th>`;
      });
    }
    headHtml += '</tr></thead>';

    // ── CUERPO ──
    const leafCounter = { n: 0 };
    const bodyRows    = buildRows(root, hierDimFields, pivotValues, metricFields,
                                  0, '', leafCounter, style, formatters);

    // ── TOTAL GLOBAL ──
    let totalHtml = '';
    if (showColTotals) {
      const sc = rowTotPos === 'sticky' ? ' tot-col-sticky' : '';
      totalHtml += `<tr class="total-row"><td class="dim-col" style="padding-left:8px">TOTAL</td>`;
      const rowTotGlobal = {};
      metricFields.forEach(mf => { rowTotGlobal[mf.id] = null; });
      pivotValues.forEach((pv, pi) => {
        const vals = root.totals.get(pv) || {};
        metricFields.forEach((mf, mi) => {
          const v    = vals[mf.id] ?? null;
          if (v !== null) rowTotGlobal[mf.id] = (rowTotGlobal[mf.id] ?? 0) + v;
          const fmt  = formatters.get(mf.id);
          const disp = fmt ? fmt(v) : (v === null ? '—' : v);
          const cls  = 'met-val' + (mi === 0 && pi > 0 ? ' grp-start' : '');
          totalHtml += `<td class="${cls}" data-val="${esc(v === null ? '' : String(v))}" ` +
            `data-pct="100.0" data-fid="${esc(mf.id)}" ` +
            `data-label="Total ${esc(mf.name)} / ${esc(pv)}">${disp}</td>`;
        });
      });
      if (showRowTotals) {
        metricFields.forEach(mf => {
          const v    = rowTotGlobal[mf.id];
          const fmt  = formatters.get(mf.id);
          const disp = fmt ? fmt(v) : (v === null ? '—' : v);
          totalHtml += `<td class="met-val${sc ? ' ' + sc : ''}" ` +
            `data-val="${esc(v === null ? '' : String(v))}" data-pct="100.0" ` +
            `data-fid="${esc(mf.id)}" data-label="Gran total ${esc(mf.name)}">${disp}</td>`;
        });
      }
      totalHtml += '</tr>';
    }

    // ── MONTAR DOM ──
    wrap.querySelector('#pv-scroll').innerHTML =
      `<table>${headHtml}<tbody>${bodyRows.join('')}${totalHtml}</tbody></table>`;

    attachEvents(style, formatters, metricFields);
    applySearch();
    setupResizeObserver(style);
  }

  /* ----------------------------------------------------------
     RESIZE OBSERVER
     Se crea una sola vez. En cada cambio de tamaño re-inyecta
     solo el CSS (no reconstruye el DOM de datos).
  ---------------------------------------------------------- */
  function setupResizeObserver(style) {
    if (resizeObserver) return; // ya activo
    if (!container) return;

    resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (!lastData) return;
        const { style: s }    = lastData;
        const userFontSize    = getStyle(s, 'rowFontSize',  '12');
        const userDimColWidth = getStyle(s, 'dimColWidth',  '220');
        const fontSize        = computeFontSize(width, userFontSize);
        const dimColWidth     = computeDimColWidth(width, userDimColWidth);
        // Solo re-inyectar CSS — el DOM de datos no cambia
        injectStyles(s, fontSize, dimColWidth);
      }
    });

    resizeObserver.observe(container);
  }

  /* ----------------------------------------------------------
     EXPAND / COLAPSAR
  ---------------------------------------------------------- */
  function toggleNode(path) {
    expandedState[path] = expandedState[path] === false ? true : false;
    const isNowExpanded = expandedState[path] !== false;
    const btn = document.querySelector(`.toggle-btn[data-path="${CSS.escape(path)}"]`);
    if (btn) btn.textContent = isNowExpanded ? '▾' : '▸';
    document.querySelectorAll('tbody tr[data-path]').forEach(tr => {
      const rowPath = tr.getAttribute('data-path');
      const isDesc  = rowPath.startsWith(path + '||') || rowPath === path + '__sub';
      if (!isDesc) return;
      if (!isNowExpanded) {
        tr.classList.add('pv-hidden');
      } else {
        const rowParent = tr.getAttribute('data-parent') || '';
        const ok = isAncestorChainExpanded(rowParent) &&
          getAncestorPaths(rowPath).every(ap => expandedState[ap] !== false);
        if (ok) tr.classList.remove('pv-hidden');
      }
    });
    applySearch();
  }

  function expandAll() {
    document.querySelectorAll('tbody tr[data-path]').forEach(tr => {
      expandedState[tr.getAttribute('data-path')] = true;
      tr.classList.remove('pv-hidden');
    });
    document.querySelectorAll('.toggle-btn').forEach(b => { b.textContent = '▾'; });
    applySearch();
  }

  function collapseAll() {
    document.querySelectorAll('tbody tr[data-path]').forEach(tr => {
      const path  = tr.getAttribute('data-path');
      const level = parseInt(tr.getAttribute('data-level') ?? '99', 10);
      expandedState[path] = false;
      if (level > 0 || tr.classList.contains('subtotal-row')) tr.classList.add('pv-hidden');
    });
    document.querySelectorAll('.toggle-btn').forEach(b => { b.textContent = '▸'; });
  }

  /* ----------------------------------------------------------
     BUSCADOR LIVE
  ---------------------------------------------------------- */
  function applySearch() {
    const term = searchTerm.trim().toLowerCase();
    if (!term) {
      document.querySelectorAll('tr.pv-filtered').forEach(tr => tr.classList.remove('pv-filtered'));
      return;
    }
    const matchPaths = new Set();
    document.querySelectorAll('tbody tr[data-label]').forEach(tr => {
      if ((tr.getAttribute('data-label') || '').toLowerCase().includes(term)) {
        const path = tr.getAttribute('data-path') || '';
        matchPaths.add(path);
        getAncestorPaths(path).forEach(ap => matchPaths.add(ap));
      }
    });
    document.querySelectorAll('tbody tr[data-path]').forEach(tr => {
      if (tr.classList.contains('subtotal-row') || tr.classList.contains('total-row')) return;
      const path = tr.getAttribute('data-path') || '';
      if (matchPaths.has(path)) {
        tr.classList.remove('pv-filtered');
        tr.classList.remove('pv-hidden');
      } else {
        tr.classList.add('pv-filtered');
      }
    });
  }

  /* ----------------------------------------------------------
     TOOLTIP — bifurcación mouse / touch
  ---------------------------------------------------------- */
  function initTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'pv-tooltip';
    document.body.appendChild(tooltipEl);
  }

  function renderTooltip(label, rawVal, pct, formatter) {
    const displayed = formatter
      ? formatter(rawVal === '' ? null : rawVal)
      : (rawVal === '' ? '—' : rawVal);
    const pctStr = pct === 'n/a' ? 'n/a' : `${pct}%`;
    tooltipEl.innerHTML =
      `<strong>${label}</strong><br>Valor: ${displayed}<br>% sobre total: ${pctStr}`;
  }

  function showTooltipAt(x, y) {
    if (!tooltipEl) return;
    tooltipEl.style.display = 'block';
    // Forzar reflow para obtener dimensiones reales
    const tw = tooltipEl.offsetWidth, th = tooltipEl.offsetHeight;
    let left = x + 12, top = y + 12;
    if (left + tw > window.innerWidth  - 8) left = x - tw - 12;
    if (top  + th > window.innerHeight - 8) top  = y - th - 12;
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top  = top  + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    lastTouchCell = null;
  }

  /* ----------------------------------------------------------
     EVENTOS
  ---------------------------------------------------------- */
  function attachEvents(style, formatters, metricFields) {
    // Expand/colapsar
    document.querySelectorAll('.toggle-btn[data-path]').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); toggleNode(btn.getAttribute('data-path')); });
    });

    // Ordenación por cabecera
    document.querySelectorAll('thead th.met-col[data-pv]').forEach(th => {
      th.addEventListener('click', () => {
        const pv = th.getAttribute('data-pv'), mid = th.getAttribute('data-mid');
        sortState = (sortState && sortState.pivotVal === pv && sortState.metricId === mid)
          ? { ...sortState, asc: !sortState.asc }
          : { pivotVal: pv, metricId: mid, asc: false };
        render(lastData);
      });
    });

    // ── Tooltip: mouse vs touch ──
    const cells = document.querySelectorAll('td.met-val, td.tot-col-sticky');

    if (!IS_TOUCH) {
      // MOUSE: hover clásico
      cells.forEach(td => {
        td.addEventListener('mouseenter', e => {
          const label  = td.getAttribute('data-label'); if (!label) return;
          const rawVal = td.getAttribute('data-val');
          const pct    = td.getAttribute('data-pct');
          const fid    = td.getAttribute('data-fid');
          const fmt    = fid ? formatters.get(fid) : null;
          renderTooltip(label, rawVal, pct, fmt);
          showTooltipAt(e.clientX, e.clientY);
        });
        td.addEventListener('mousemove', e => {
          if (tooltipEl && tooltipEl.style.display !== 'none')
            showTooltipAt(e.clientX, e.clientY);
        });
        td.addEventListener('mouseleave', hideTooltip);
      });
    } else {
      // TOUCH: tap para mostrar, auto-ocultar tras 2.5s, tap en otra celda lo cierra
      cells.forEach(td => {
        td.addEventListener('touchstart', e => {
          e.preventDefault(); // evita el tap-delay de 300ms en iOS
          const label  = td.getAttribute('data-label'); if (!label) return;
          const rawVal = td.getAttribute('data-val');
          const pct    = td.getAttribute('data-pct');
          const fid    = td.getAttribute('data-fid');
          const fmt    = fid ? formatters.get(fid) : null;

          if (lastTouchCell === td) {
            // Segundo tap en la misma celda → cerrar
            hideTooltip();
            return;
          }
          lastTouchCell = td;

          // Posicionar desde el primer toque
          const touch = e.touches[0];
          renderTooltip(label, rawVal, pct, fmt);
          showTooltipAt(touch.clientX, touch.clientY);

          // Auto-ocultar tras 2.5s
          if (tooltipTimer) clearTimeout(tooltipTimer);
          tooltipTimer = setTimeout(hideTooltip, 2500);
        }, { passive: false });
      });

      // Tocar fuera de una celda de métrica cierra el tooltip
      document.addEventListener('touchstart', e => {
        if (!tooltipEl || tooltipEl.style.display === 'none') return;
        if (!e.target.closest('td.met-val, td.tot-col-sticky')) hideTooltip();
      }, { passive: true });
    }

    // Buscador
    const searchInput = document.getElementById('pv-search');
    if (searchInput) {
      searchInput.value = searchTerm;
      searchInput.addEventListener('input', e => { searchTerm = e.target.value; applySearch(); });
    }

    // Botones expandir/colapsar todo
    document.getElementById('pv-expand-all')  ?.addEventListener('click', expandAll);
    document.getElementById('pv-collapse-all')?.addEventListener('click', collapseAll);
  }

  /* ----------------------------------------------------------
     CONTENEDOR PRINCIPAL
  ---------------------------------------------------------- */
  function getOrCreateWrap() {
    if (container && document.body.contains(container)) return container;

    // Limpiar ResizeObserver anterior si existe
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }

    document.body.innerHTML = '';
    const toolbar = document.createElement('div');
    toolbar.id = 'pv-toolbar';
    toolbar.innerHTML =
      `<input id="pv-search" type="search" placeholder="🔍 Buscar..." autocomplete="off">` +
      `<button class="pv-btn" id="pv-expand-all">⊞ Expandir todo</button>` +
      `<button class="pv-btn" id="pv-collapse-all">⊟ Colapsar todo</button>`;
    const scroll = document.createElement('div');
    scroll.id = 'pv-scroll';
    container = document.createElement('div');
    container.id = 'pv-wrap';
    container.appendChild(toolbar);
    container.appendChild(scroll);
    document.body.appendChild(container);
    initTooltip();
    return container;
  }

  /* ----------------------------------------------------------
     ESCAPE HTML
  ---------------------------------------------------------- */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ----------------------------------------------------------
     PUNTO DE ENTRADA
  ---------------------------------------------------------- */
  dscc.subscribeToData(render, { transform: dscc.objectTransform });

})();
