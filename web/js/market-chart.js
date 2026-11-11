/**
 * The TAIEX chart stack shared by index.html (大盤今日) and drawdown.html
 * (大盤修正波段): the index (K or line), turnover, the selected 法人 desk's daily
 * and cumulative net, margin change / balance / maintenance ratio and,
 * optionally, foreign net open interest in TAIEX futures - all on one x-axis.
 *
 * Correction episodes are the drawdown page's business. The chart only asks
 * for them through opts.bands() so it can shade them and name them in the
 * tooltip; with no bands it is a plain market chart.
 *
 *   const mc = MarketChart.create({el, rows, futures, bands, onEtf, afterRender});
 *   mc.setView(range|null); mc.render();
 *
 * Needs common.js (window.TWF) and ECharts loaded first.
 */
(function(){
  "use strict";
  const { alpha, COLORS, BAND, nf, sgn, yi, sgnYi, fd, isNarrow, segHandler } = window.TWF;

  // Individual positions get a margin call below this; the market-wide ratio
  // nearing it is when forced selling shows up.
  const MARGIN_CALL = 130;

  function create(opts){
    const rows = opts.rows;
    const ids = Object.assign({desk:'seg-desk', etf:'seg-etf', chartType:'seg-chart',
                               start:'zoom-start', legendIndex:'lg-index'}, opts.ids || {});
    const bands = opts.bands || (() => null);
    const dates  = rows.map(r=>r.date);
    const N      = rows.length;
    const gap    = v => (v===null||v===undefined) ? '-' : v;   // '-' renders as a gap in ECharts
    const closes = rows.map(r=>gap(r.close));
    const turn   = rows.map(r=>gap(r.turnoverYi));
    let desk = 'foreign';          // which desk the two flow panels show
    let chartType = 'candle';

    // TWSE publishes three institutional desks. Only one is plotted at a time:
    // three overlapping bar series across 1,800 sessions is unreadable, and the
    // palette is validated for the hues already in use — a fourth and fifth
    // categorical colour would need re-validating for CVD separation. The
    // selector keeps it to one series, so no new hue is introduced at all.
    // 合計 sums whichever desks reported that day, and is missing only when all
    // three are — the same "no fake zeros" rule the single-desk series follow.
    const net = k => r => r[k];
    const DESKS = {
      foreign:{val:net('foreignNetYi'), label:'外資'},
      trust:  {val:net('trustNetYi'),   label:'投信'},
      dealer: {val:net('dealerNetYi'),  label:'自營商'},
      total:  {val:r=>{
        const vs = ['foreignNetYi','trustNetYi','dealerNetYi']
          .map(k=>r[k]).filter(v=>v!==null&&v!==undefined);
        return vs.length ? +vs.reduce((a,b)=>a+b,0).toFixed(2) : null;
      }, label:'三大法人'}
    };
    const deskFlow = () => rows.map(r=>gap(DESKS[desk].val(r)));
    let fgn = deskFlow();

    // The margin view: as published, or with the ETF slice taken out. TWSE
    // gives the loan only as a market total, so the ETF part is the pipeline's
    // estimate and exists only from 2022; earlier days have no ex-ETF figure.
    // Everything margin-related (panels, tooltip, and the page's KPIs and
    // episode metrics via mrows()) reads `mrows`, so one switch moves it all.
    let etf = 'incl';
    const rowsExEtf = rows.map(r=>({...r,
      marginBalanceYi: r.marginBalanceExEtfYi ?? null, marginRatio: r.marginRatioExEtf ?? null}));
    let mrows = rows;
    let mgn, mRatio, mgnChg;
    function buildMargin(){
      mrows = etf === 'excl' ? rowsExEtf : rows;
      mgn    = mrows.map(r=>gap(r.marginBalanceYi));
      mRatio = mrows.map(r=>gap(r.marginRatio));
      // Day-on-day margin change. A missing day on either side leaves a gap
      // rather than diffing across it.
      mgnChg = mrows.map((r,i)=>{
        const m0 = i>0 ? mrows[i-1].marginBalanceYi : null, m1 = r.marginBalanceYi;
        return (m0===null||m0===undefined||m1===null||m1===undefined) ? null : +(m1-m0).toFixed(2);
      });
    }
    buildMargin();

    // Foreign net open interest in 臺股期貨 (contracts). TAIFEX serves ~3 years,
    // so earlier sessions are gaps. Its day-on-day change goes in the tooltip.
    const futOI = rows.map(r=>gap(r.foreignTxNetOI));
    const futChg = rows.map((r,i)=>{
      const a = i>0 ? rows[i-1].foreignTxNetOI : null, b = r.foreignTxNetOI;
      return (a===null||a===undefined||b===null||b===undefined) ? null : b-a;
    });

    // Cumulative desk net, rebased to the start of whatever window is in view.
    // Anchoring it to the series start would make the line inside a zoomed
    // window read as a slice of a years-long total — the level would be
    // dominated by history and the shape of the window itself squeezed flat.
    // Restarting at zero on the left edge answers the question actually being
    // asked: how much did this desk buy or sell *during this stretch*.
    // A missing day counts as no change, so the line stays continuous.
    let cumBase = 0;
    function buildCum(from){
      const val = DESKS[desk].val;
      let s = 0;
      return rows.map((r, i) => {
        if(i < from) return '-';                 // outside the window: draw nothing
        s += (val(r) || 0);
        return +s.toFixed(2);
      });
    }
    let cumView = buildCum(0);
    const deskName = () => DESKS[desk].label;
    const cumTitle = () => cumBase > 0
      ? `${deskName()}累計買賣超（億元，自 ${fd(dates[cumBase])} 起算）`
      : `${deskName()}累計買賣超（億元，自期初起算）`;

    // Current x-range, as data indices. render() re-applies this on every
    // setOption — without it, notMerge:true would silently reset the view to
    // the full range every time the chart is rebuilt.
    let zoomRange = null;   // null = show everything
    // The last `months` calendar months of sessions.
    function latest(months){
      const from = new Date(dates[N-1]);
      from.setUTCMonth(from.getUTCMonth() - months);
      const s = dates.findIndex(d => d > from.toISOString().slice(0,10));
      return s > 0 ? {s, e:N-1} : null;
    }

    // ECharts candlestick wants [open, close, low, high] — note that order.
    const ohlc = rows.map(r =>
      (r.open===null||r.close===null||r.low===null||r.high===null)
        ? '-' : [r.open, r.close, r.low, r.high]);

    const chart = echarts.init(opts.el, null, {renderer:'canvas'});

    // Stacked panels on one shared x-axis. Daily and cumulative desk net live
    // in separate panels rather than sharing one plot with two y-scales — a
    // dual-axis chart makes the crossings look meaningful when they are an
    // artifact of the scaling.
    // On desktop the whole stack is sized to the window, so price, turnover,
    // flows and margin can be read in one screen without scrolling between
    // them. Phones get the same panels, just tighter: a 70px y-axis gutter
    // eats a fifth of a 390px screen, and the full stack needs the page to
    // scroll rather than each panel being squashed.
    const NAMES = ['加權指數','成交金額（億元）','買賣超（億元）',
                   '累計買賣超（億元）','融資增減（億元）','融資餘額（億元）','融資維持率（%）']
      .concat(opts.futures ? ['外資台指期淨未平倉（口）'] : []);
    const CUM = 3;                 // computed title: desk name + rebase date
    const FLOW = 2;                // computed title: desk name
    const MGN_CHG = 4, MGN = 5, MGN_RATIO = 6;
    const FUT = opts.futures ? 7 : -1;
    const MARGIN_PANELS = [MGN_CHG, MGN, MGN_RATIO];
    const etfTag = () => etf === 'excl' ? '（排除 ETF）' : '';
    const panelTitle = (i, name) => i===CUM ? cumTitle() : i===FLOW ? deskName()+name
      : MARGIN_PANELS.includes(i) && etf === 'excl' ? name + ' · 排除 ETF' : name;
    // Window height taken by the page around the chart (panel head, summary
    // bar, legend) on desktop.
    const reserve = opts.reserve ?? 150;

    function layout(){
      const narrow = isNarrow();
      const gap    = narrow ? 40  : 30;      // room for each panel's title
      const top0   = narrow ? 28  : 26;
      const foot   = narrow ? 34  : 44;      // room for the zoom slider
      let mainH = 190, subH = 70;
      if(!narrow){
        // Solve top0 + main + subs*(sub+gap) + foot = avail with main = 2.8*sub,
        // clamped so a short window still gets readable panels and a tall one
        // stops growing at the old fixed size.
        const avail = window.innerHeight - reserve;
        const subs = NAMES.length - 1;
        subH  = Math.max(58, Math.min(88,
                  Math.floor((avail - top0 - foot - subs*gap) / (subs + 2.8))));
        mainH = Math.min(250, Math.round(subH * 2.8));
      }
      const grids = [];
      let top = top0;
      for(let i=0;i<NAMES.length;i++){
        const h = i===0 ? mainH : subH;
        grids.push({name:NAMES[i], top, height:h});
        top += h + gap;
      }
      return {
        grids, narrow,
        left:  narrow ? 46 : 70,
        right: narrow ? 12 : 26,
        totalH: top + foot
      };
    }
    let L = layout();
    const LAST = NAMES.length - 1;

    const axisCommon = i => ({
      type:'category', data:dates, gridIndex:i, boundaryGap:false,
      axisLine:{lineStyle:{color:COLORS.line}},
      axisTick:{show:false},
      splitLine:{show:false},
      axisPointer:{show:true, label:{show:i===LAST, backgroundColor:COLORS.line, color:COLORS.ink}},
      axisLabel: i===LAST
        ? {color:COLORS.ink3, fontSize:L.narrow?9:11, hideOverlap:true,
           // On a phone there is no room for YYYY/MM on every tick
           formatter:v=> L.narrow ? v.slice(2,4)+'/'+v.slice(5,7)
                                  : v.slice(0,4)+'/'+v.slice(5,7)}
        : {show:false}
    });
    const valCommon = i => ({
      type:'value', gridIndex:i, scale:i===0,
      ...(i===MGN_RATIO ? {min:v=>Math.min(MARGIN_CALL-10, Math.floor(v.min/10)*10),
                           max:v=>Math.ceil(v.max/10)*10} : {}),
      // The sub-panels are 60-90px tall: three ticks, not a stack of seven
      splitNumber: i===0 ? 5 : 3,
      axisLine:{show:false}, axisTick:{show:false},
      splitLine:{lineStyle:{color:COLORS.line2}},
      axisLabel:{color:COLORS.ink3, fontSize:L.narrow?9:11,
        // 46px of gutter cannot hold "45,000"; abbreviate hard on narrow screens
        formatter:v=>{
          const a = Math.abs(v);
          // Enough decimals that neighbouring ticks never print the same label
          // (16,000 and 16,500 both rounding to "1.6萬")
          if(a>=10000) return (v/10000).toFixed(
            v%10000===0 ? 0 : v%1000===0 ? 1 : 2)+'萬';
          if(L.narrow && a>=1000) return (v/1000).toFixed(0)+'k';
          return nf(v,0);
        }}
    });

    // Correction bands, when the page supplies episodes.
    function markAreaFor(main){
      const b = bands();
      if(!b) return undefined;
      return {
        silent:true,
        itemStyle:{color: main ? BAND.main : BAND.sub},
        emphasis:{disabled:true},
        data: b.episodes.map((e,i)=>{
          const on = i===b.selected;
          return [
            {xAxis:e.peakDate,
             itemStyle:{color: on ? BAND.on : (main ? BAND.main : BAND.sub)},
             label: main ? {show:true, formatter:'#'+(i+1), position:'insideTop',
                            color: on ? COLORS.bandLabel : COLORS.bandLabelOff, fontSize:10} : {show:false}},
            {xAxis:e.troughDate}
          ];
        })
      };
    }

    function tooltipFormatter(params){
      if(!params || !params.length) return '';
      const i = params[0].dataIndex, r = rows[i];
      if(!r) return '';
      const li = (label,val,color)=>
        `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.65">
           <span style="color:${COLORS.ink3}">${color?`<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${color};margin-right:6px"></i>`:''}${label}</span>
           <span style="font-variant-numeric:tabular-nums;color:${COLORS.ink}">${val}</span>
         </div>`;
      const signed = (v, txt) => v===null||v===undefined ? '—'
        : `<span style="color:${v>=0?COLORS.up:COLORS.down}">${txt}</span>`;
      const chg = i>0 && r.close!==null && rows[i-1].close!==null ? r.close-rows[i-1].close : null;
      const chgPct = (chg!==null && rows[i-1].close) ? chg/rows[i-1].close*100 : null;
      const chgColor = chg===null ? COLORS.ink2 : (chg>=0?COLORS.up:COLORS.down);
      const mChg = mgnChg[i];
      const mChgColor = mChg===null ? null : (mChg>=0?COLORS.up:COLORS.down);

      // Which correction window this day falls in
      let band='';
      const b = bands();
      const eps = b ? b.episodes : [];
      const k = eps.findIndex(e=> i>=e.peakIdx && i<=(e.recoverIdx===null? N-1 : e.recoverIdx));
      if(k>=0){
        const e=eps[k];
        const phase = i<=e.troughIdx ? '下跌中' : '收復中';
        band = `<div style="margin-top:7px;padding-top:6px;border-top:1px solid ${COLORS.line};color:${COLORS.cum};font-size:11.5px">
                  修正 #${k+1} · ${phase} · 波段跌幅 ${e.drawdownPct.toFixed(2)}%</div>`;
      }
      const fut = opts.futures
        ? li('外資台指期淨未平倉', r.foreignTxNetOI===null||r.foreignTxNetOI===undefined ? '—'
            : signed(r.foreignTxNetOI, nf(r.foreignTxNetOI,0)+' 口') +
              (futChg[i]===null ? '' : ` <span style="color:${COLORS.ink3}">(${sgn(futChg[i],0)})</span>`))
        : '';
      return `<div style="min-width:230px;font-size:12.5px">
        <div style="color:${COLORS.ink};font-weight:600;margin-bottom:6px">${fd(r.date)}</div>
        ${li('收盤', nf(r.close,2), COLORS.index)}
        ${li('漲跌', chg===null?'—':`<span style="color:${chgColor}">${sgn(chg,2)} (${sgn(chgPct,2)}%)</span>`)}
        ${li('高 / 低', `${nf(r.high,2)} / ${nf(r.low,2)}`)}
        ${li('成交金額', yi(r.turnoverYi), COLORS.turnover)}
        ${Object.values(DESKS).map(dk=>{
            const v = dk.val(r);
            const c = v===null||v===undefined ? null : (v>=0?COLORS.up:COLORS.down);
            return li(dk.label + (DESKS[desk]===dk ? ' ●' : ''),
              v===null||v===undefined ? '—' : `<span style="color:${c}">${sgnYi(v,1)}</span>`, c);
          }).join('')}
        ${li(deskName()+'累計', cumView[i]==='-' ? '—' : sgnYi(cumView[i],0), COLORS.cum)}
        ${li('融資餘額'+etfTag(), yi(mrows[i].marginBalanceYi), COLORS.margin)}
        ${li('融資增減', mChg===null ? '—' : `<span style="color:${mChgColor}">${sgnYi(mChg,1)}</span>`, mChgColor)}
        ${li('融資維持率'+etfTag(), mrows[i].marginRatio===null||mrows[i].marginRatio===undefined ? '—' : nf(mrows[i].marginRatio,2)+'%', COLORS.margin)}
        ${fut}
        ${band}</div>`;
    }

    // Both dataZoom components must carry the same range, or the slider and
    // the inside-zoom disagree after a rebuild.
    const zoomOpt = () => zoomRange
      ? {startValue: zoomRange.s, endValue: zoomRange.e}
      : {start: 0, end: 100};

    function mainSeries(){
      const common = { name:'加權指數', xAxisIndex:0, yAxisIndex:0, markArea: markAreaFor(true) };
      if(chartType === 'candle'){
        return { ...common, type:'candlestick', data:ohlc,
          itemStyle:{                       // 台股慣例：紅漲綠跌
            color:COLORS.up,       borderColor:COLORS.up,      // 收 >= 開
            color0:COLORS.down,    borderColor0:COLORS.down    // 收 <  開
          },
          // At full zoom the candles are sub-pixel; barMaxWidth keeps them from
          // fusing into a solid block once zoomed in.
          barMaxWidth:9
        };
      }
      return { ...common, type:'line', data:closes,
        showSymbol:false, symbol:'circle', symbolSize:8, connectNulls:false,
        lineStyle:{width:2, color:COLORS.index},
        areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[
          {offset:0,color:alpha(COLORS.index,.14)},{offset:1,color:alpha(COLORS.index,0)}])} };
    }

    const zeroLine = () => ({silent:true, symbol:'none', data:[{yAxis:0}],
      lineStyle:{color:COLORS.ink4, width:1}, label:{show:false}});
    const signBars = (name, data, i) => ({ name, type:'bar', data, xAxisIndex:i, yAxisIndex:i,
      itemStyle:{ borderRadius:[2,2,0,0], color:p => (p.value>=0 ? COLORS.up : COLORS.down) },
      barMaxWidth:6, markLine:zeroLine() });

    const startInput = document.getElementById(ids.start);
    function syncStartInput(){ if(startInput) startInput.value = dates[zoomRange ? zoomRange.s : 0]; }

    function render(){
      // Recompute on every render so a rotation or window resize is picked up.
      L = layout();
      fgn = deskFlow();                        // follows the 法人 control
      if(parseInt(opts.el.style.height, 10) !== L.totalH){
        opts.el.style.height = L.totalH + 'px';
        chart.resize();
      }
      const hasBands = !!bands();
      const opt = {
        backgroundColor:'transparent',
        animation:false,
        textStyle:{fontFamily:'Inter, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif'},
        title: L.grids.map((g,i)=>({
          text: panelTitle(i, g.name), left:L.narrow?8:L.left+4, top:g.top-(L.narrow?19:17),
          textStyle:{color:COLORS.ink3, fontSize:L.narrow?10:11.5, fontWeight:500}
        })),
        grid: L.grids.map(g=>({left:L.left, right:L.right, top:g.top, height:g.height})),
        xAxis: NAMES.map((_,i)=>axisCommon(i)),
        yAxis: NAMES.map((_,i)=>valCommon(i)),
        axisPointer:{
          link:[{xAxisIndex:'all'}],
          lineStyle:{color:COLORS.pointer, width:1, type:'dashed'},
          label:{backgroundColor:COLORS.line}
        },
        tooltip:{
          trigger:'axis', axisPointer:{type:'cross'},
          backgroundColor:alpha(COLORS.surface,.97), borderColor:COLORS.line, borderWidth:1,
          padding:L.narrow?[8,9]:[10,12], confine:true,
          extraCssText:'backdrop-filter:blur(4px);border-radius:8px;max-width:88vw',
          textStyle:{color:COLORS.ink, fontSize:L.narrow?11:12.5},
          formatter: tooltipFormatter
        },
        dataZoom:[
          // On touch, ECharts' inside-zoom captures one-finger drags, which
          // would hijack vertical page scrolling. Leave pinch-zoom on, panning
          // off, and let the (enlarged) slider be the deliberate way to move.
          {type:'inside', xAxisIndex:NAMES.map((_,i)=>i), ...zoomOpt(), zoomOnMouseWheel:true,
           moveOnMouseMove: !L.narrow, preventDefaultMouseMove: !L.narrow},
          {type:'slider', xAxisIndex:NAMES.map((_,i)=>i), height:L.narrow?26:20, bottom:10, ...zoomOpt(),
           backgroundColor:COLORS.surface, borderColor:COLORS.line, fillerColor:alpha(COLORS.turnover,.14),
           handleStyle:{color:COLORS.ink4}, moveHandleStyle:{color:COLORS.ink4},
           dataBackground:{lineStyle:{color:COLORS.zoomTrack}, areaStyle:{color:COLORS.line2}},
           selectedDataBackground:{lineStyle:{color:COLORS.zoomTrackOn}, areaStyle:{color:COLORS.zoomFill}},
           textStyle:{color:COLORS.ink3, fontSize:10},
           // Full date, so dragging a handle can land on an exact start day
           labelFormatter: v => dates[Math.round(v)] ? fd(dates[Math.round(v)]) : ''}
        ],
        series:[
          mainSeries(),

          { name:'成交金額', type:'bar', data:turn, xAxisIndex:1, yAxisIndex:1,
            itemStyle:{color:COLORS.turnover, borderRadius:[2,2,0,0]}, barMaxWidth:6 },

          signBars(deskName()+'買賣超', fgn, FLOW),

          { name:deskName()+'累計買賣超', type:'line', data:cumView, xAxisIndex:CUM, yAxisIndex:CUM,
            showSymbol:false, symbolSize:8, lineStyle:{width:2, color:COLORS.cum},
            areaStyle:{color:alpha(COLORS.cum,.10)},
            markLine:zeroLine(), markArea: markAreaFor(false) },

          // Same red-up / green-down bars as the desk flows, so a margin
          // build-up and a foreign sell-off read in one visual language.
          signBars('融資增減', mgnChg.map(gap), MGN_CHG),

          { name:'融資餘額', type:'line', data:mgn, xAxisIndex:MGN, yAxisIndex:MGN,
            showSymbol:false, symbolSize:8, connectNulls:false,
            lineStyle:{width:2, color:COLORS.margin},
            areaStyle:{color:alpha(COLORS.margin,.10)},
            markArea: markAreaFor(false) },

          // Not scale:true like the index — the 130% call line must stay in
          // view so the distance to it reads at a glance.
          { name:'融資維持率', type:'line', data:mRatio, xAxisIndex:MGN_RATIO, yAxisIndex:MGN_RATIO,
            showSymbol:false, symbolSize:8, connectNulls:false,
            lineStyle:{width:2, color:COLORS.margin},
            markLine:{silent:true, symbol:'none', data:[{yAxis:MARGIN_CALL}],
              lineStyle:{color:COLORS.down, width:1, type:'dashed'}, label:{show:false}},
            markArea: markAreaFor(false) },

          // A position, not a flow, but signed the same way: red bars net long,
          // green net short, so it reads in the same language as the panels
          // above it.
          ...(opts.futures ? [signBars('外資台指期淨未平倉', futOI, FUT)] : []),

          // ECharts mis-places a markArea hosted on a bar series once dataZoom
          // filters the data: the bands drift by days to weeks against the
          // index panel. Hang the bar panels' bands on empty line series
          // instead, which resolve dates through the axis like the index does.
          ...(hasBands ? [1, FLOW, MGN_CHG].concat(opts.futures ? [FUT] : []).map(i=>({
            type:'line', data:[], silent:true,
            xAxisIndex:i, yAxisIndex:i, markArea: markAreaFor(false) })) : [])
        ]
      };
      chart.setOption(opt, {notMerge:true});

      // Pin the 法人 control to the right end of the daily-flow panel's title row.
      const deskSeg = document.getElementById(ids.desk);
      deskSeg.style.top   = (L.grids[FLOW].top - 30) + 'px';
      deskSeg.style.right = L.right + 'px';
      // ...and the ETF switch on the first margin panel's, covering all three.
      const etfSeg = document.getElementById(ids.etf);
      etfSeg.style.top   = (L.grids[MGN_CHG].top - 30) + 'px';
      etfSeg.style.right = L.right + 'px';
      syncStartInput();
      if(opts.afterRender) opts.afterRender();

      // Keep the legend swatch honest: in candlestick mode the index is drawn
      // in the red/green up-down pair, not the neutral line colour.
      const lg = document.getElementById(ids.legendIndex);
      if(lg) lg.style.background = chartType === 'candle'
        ? `linear-gradient(135deg, ${COLORS.up} 50%, ${COLORS.down} 50%)`
        : COLORS.index;
    }

    // Re-anchor the cumulative line to the left edge of the view.
    function setCumBase(from){
      if(from === cumBase) return false;
      cumBase = from;
      cumView = buildCum(from);
      return true;
    }
    // Set the x-range (and rebase the cumulative line to it) for the next render.
    function setView(range){
      zoomRange = range;
      setCumBase(range ? range.s : 0);
    }

    // Switching desk changes only what the two flow panels plot.
    segHandler(ids.desk, v=>{ desk = v; cumView = buildCum(cumBase); }, render);
    // The page may own figures that read the margin view (KPIs, episode
    // metrics); it redraws everything itself through onEtf.
    segHandler(ids.etf, v=>{ etf = v; buildMargin(); }, opts.onEtf || render);
    // Line/candlestick changes nothing but the chart; the zoom stays put.
    segHandler(ids.chartType, v=>{ chartType = v; }, render);

    // Start-day picker: jump the left edge of the view to the first session on
    // or after the chosen date, keeping the right edge where it is.
    if(startInput){
      startInput.min = dates[0]; startInput.max = dates[N-1];
      startInput.addEventListener('change', ()=>{
        const v = startInput.value;
        if(!v){ syncStartInput(); return; }
        let s = dates.findIndex(d => d >= v);
        if(s < 0) s = N-1;
        let e = zoomRange ? zoomRange.e : N-1;
        if(e <= s) e = N-1;
        if(s >= e) s = Math.max(0, e-1);
        chart.dispatchAction({type:'dataZoom', startValue:s, endValue:e});
      });
    }

    // Keep zoomRange in step with pans and wheel-zooms, so a later rebuild
    // (e.g. toggling to candlesticks) doesn't throw away where the user is looking.
    let cumTimer = null;
    chart.on('dataZoom', ()=>{
      const dz = (chart.getOption().dataZoom || [])[0];
      if(!dz) return;
      let s = dz.startValue, e = dz.endValue;
      // Wheel-zoom often reports percentages rather than indices; accept either.
      if(typeof s !== 'number' || typeof e !== 'number'){
        if(typeof dz.start !== 'number' || typeof dz.end !== 'number') return;
        s = dz.start / 100 * (N-1);
        e = dz.end   / 100 * (N-1);
      }
      zoomRange = (s <= 0 && e >= N-1) ? null : {s:Math.round(s), e:Math.round(e)};
      syncStartInput();

      clearTimeout(cumTimer);
      cumTimer = setTimeout(()=>{
        if(!setCumBase(zoomRange ? zoomRange.s : 0)) return;
        // Partial merge: only the cumulative series' data and its title change,
        // so there is no need to rebuild every grid while the user still drags.
        chart.setOption({
          title: NAMES.map((n,i)=>({text: panelTitle(i, n)})),
          series: NAMES.map((_,i)=> i===CUM ? {data: cumView} : {})
        });
      }, 120);
    });

    // Crossing the mobile breakpoint changes grid geometry, axis fonts and
    // label formats, so it needs a full re-render — a bare resize() would keep
    // the old desktop margins on a phone. On desktop the panel heights follow
    // the window height, so a change there rebuilds too. Debounced because
    // rotation fires a burst.
    let wasNarrow = isNarrow(), rzTimer = null;
    window.addEventListener('resize', ()=>{
      clearTimeout(rzTimer);
      rzTimer = setTimeout(()=>{
        const now = isNarrow();
        if(now !== wasNarrow){ wasNarrow = now; render(); }
        else if(layout().totalH !== L.totalH) render();
        else chart.resize();
      }, 150);
    });

    return {
      chart, render, setView, latest, rows, dates, N,
      view: () => zoomRange,
      mrows: () => mrows,
      etf: () => etf,
      etfTag,
      panels: NAMES.length
    };
  }

  window.MarketChart = { create, MARGIN_CALL };
})();
