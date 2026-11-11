/**
 * Shared by the market pages (index.html, drawdown.html): palette, number and
 * date formatting, the theme toggle and the segmented-control wiring.
 *
 * Plain script, no module system: the pages open straight from file:// and
 * from the single-file bundle, so everything hangs off window.TWF.
 */
(function(){
  "use strict";

  // Every colour the charts draw is read from the stylesheet's custom
  // properties, so a palette edit in CSS reaches the canvas too.
  const C = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

  // rgba() from one of the hex vars, so a tint stays tied to its source colour
  // instead of being restated as a literal that silently goes stale.
  const alpha = (hex, a) => {
    const h = hex.replace('#','');
    const n = parseInt(h.length===3 ? h.split('').map(c=>c+c).join('') : h, 16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
  };

  // Filled by readColors(), and refilled when the theme changes: every renderer
  // reads COLORS at draw time, so a redraw picks up the new palette.
  const COLORS = {}, BAND = {};
  function readColors(){
    Object.assign(COLORS, {
      index:C('--c-index'), turnover:C('--c-turnover'), cum:C('--c-cum'),
      margin:C('--c-margin'), up:C('--c-up'), down:C('--c-down'),
      ink:C('--ink'), ink2:C('--ink-2'), ink3:C('--ink-3'),
      line:C('--line'), line2:C('--line-2'), surface:C('--surface'),
      ink4:C('--ink-4'), pointer:C('--axis-pointer'), bandOn:C('--c-band-on'),
      bandLabel:C('--band-label'), bandLabelOff:C('--band-label-off'),
      zoomTrack:C('--zoom-track'), zoomTrackOn:C('--zoom-track-on'), zoomFill:C('--zoom-fill')
    });
    // The correction mask, at its three weights.
    Object.assign(BAND, {main:alpha(COLORS.up,.13), sub:alpha(COLORS.up,.09), on:COLORS.bandOn});
  }
  readColors();

  const has = v => v!==null && v!==undefined && !Number.isNaN(v);
  const nf = (v,d=0)=> !has(v) ? '—'
        : v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
  const sgn = (v,d=0)=> !has(v) ? '—' : (v>0?'+':'') + nf(v,d);
  // Amount in 億, or a bare em-dash. Appending the unit unconditionally would
  // render a missing value as "— 億", which reads as a quantity rather than a gap.
  const yi  = (v,d=0)=> !has(v) ? '—' : nf(v,d)+' 億';
  const sgnYi = (v,d=0)=> !has(v) ? '—' : sgn(v,d)+' 億';
  const fd  = d => d ? d.slice(0,4)+'/'+d.slice(5,7)+'/'+d.slice(8,10) : '—';
  const isNarrow = () => window.innerWidth <= 720;

  // One handler per segmented control: press the clicked button, then apply.
  function segHandler(id, apply, after){
    document.getElementById(id).addEventListener('click', ev=>{
      const b = ev.target.closest('button'); if(!b) return;
      [...b.parentNode.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
      apply(b.dataset.v);
      if(after) after();
    });
  }

  // The theme button. The saved choice is applied before first paint by the
  // inline script in each page's <head>; this only flips it.
  function initTheme(btn, redraw){
    const sync = () => {
      const dark = document.documentElement.dataset.theme !== 'light';
      btn.textContent = dark ? '☀ 淺色' : '☾ 深色';
      btn.setAttribute('aria-pressed', dark ? 'false' : 'true');
    };
    sync();
    btn.addEventListener('click', ()=>{
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('atlas-theme', next); } catch(e) {}
      sync();
      readColors();
      redraw();
    });
  }

  // The "no data" banner both pages show instead of an empty shell.
  function showNoData(){
    const e = document.getElementById('error');
    e.hidden = false;
    e.innerHTML = '<strong>找不到資料。</strong><br>' +
      '請先執行 <code>python3 pipeline/fetch_data.py</code> 產生 <code>data/taiex-daily.js</code>，' +
      '再重新整理本頁。<br>本頁不使用任何模擬資料。';
  }

  window.TWF = { C, alpha, COLORS, BAND, readColors, has, nf, sgn, yi, sgnYi, fd,
                 isNarrow, segHandler, initTheme, showNoData };
})();
