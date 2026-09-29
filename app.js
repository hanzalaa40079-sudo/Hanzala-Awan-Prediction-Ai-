const $ = id => document.getElementById(id);
const state = {
  pair: "EUR/USD", tf: "1min", candles: [], apiKey: localStorage.getItem("awan_td_key") || "",
  ws: null, poll: null, streamMode: localStorage.getItem("awan_stream") || "auto",
  source: localStorage.getItem("awan_source") || "twelve",
  otcFeedUrl: localStorage.getItem("awan_otc_feed") || "",
  chart: null, series: null, forecastSeries: null, loaded: false,
  lockedPrediction: null, lockedAt: 0, signalCandleTime: 0,
  history: JSON.parse(localStorage.getItem("awan_trade_history") || "[]")
};

const chart = LightweightCharts.createChart($("chart"), {
  layout:{background:{type:"solid",color:"#04100d"},textColor:"#8eaa9d"},
  grid:{vertLines:{color:"#0a241a"},horzLines:{color:"#0a241a"}},
  rightPriceScale:{borderColor:"#14392b"},
  timeScale:{borderColor:"#14392b",timeVisible:true,secondsVisible:false},
  crosshair:{mode:LightweightCharts.CrosshairMode.Normal}
});
state.chart = chart;
state.series = chart.addCandlestickSeries({
  upColor:"#00e879",downColor:"#ff3658",borderUpColor:"#00e879",borderDownColor:"#ff3658",
  wickUpColor:"#00e879",wickDownColor:"#ff3658"
});
// Forecast overlay: these candles are visual predictions only, never actual market data.
state.forecastSeries = chart.addCandlestickSeries({
  upColor:"#7dffb6",downColor:"#ff9aae",borderUpColor:"#7dffb6",borderDownColor:"#ff9aae",
  wickUpColor:"#7dffb6",wickDownColor:"#ff9aae",priceLineVisible:false,lastValueVisible:false
});
window.addEventListener("resize",()=>chart.applyOptions({width:$("chart").clientWidth}));

function intervalSeconds(tf){
  return ({'1min':60,'5min':300,'15min':900,'30min':1800,'1h':3600,'4h':14400,'1day':86400})[tf] || 60;
}
function normalize(v){
  return Number(v.open ?? v.o), {
    time: Math.floor(new Date(v.datetime.replace(" ","T")+"Z").getTime()/1000),
    open:+v.open, high:+v.high, low:+v.low, close:+v.close
  };
}
function setStatus(text, ok=false){
  $("connectionText").textContent=text;
  $("connectionText").previousElementSibling.style.background=ok?"var(--green)":"var(--gold)";
}
function apiUrl(){
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol",state.pair);
  u.searchParams.set("interval",state.tf);
  u.searchParams.set("outputsize","180");
  u.searchParams.set("timezone","UTC");
  u.searchParams.set("apikey",state.apiKey);
  return u;
}
async function loadHistory(){
  if(state.source==="otc") return loadOTCHistory();
  if(!state.apiKey){ setStatus("Add API key"); return; }
  setStatus("Loading…");
  try{
    const r=await fetch(apiUrl());
    const j=await r.json();
    if(j.status==="error") throw new Error(j.message||"API error");
    state.candles=(j.values||[]).map(normalize).sort((a,b)=>a.time-b.time);
    state.series.setData(state.candles);
    chart.timeScale().fitContent();
    state.loaded=true;
    lockPredictionForCurrentCandle(true);
    updateUI();
    setStatus("Live data ready",true);
    runBacktest();
    renderHistory();
  }catch(e){ setStatus("Data error"); console.error(e); alert("Data connection error: "+e.message); }
}

async function poll(){
  if(state.source==="otc") return pollOTC();
  if(!state.apiKey) return;
  try{
    const r=await fetch(apiUrl());
    const j=await r.json();
    if(j.status==="error") return;
    const vals=(j.values||[]).map(normalize).sort((a,b)=>a.time-b.time);
    if(!vals.length) return;
    const map=new Map(state.candles.map(c=>[c.time,c]));
    vals.slice(-5).forEach(c=>map.set(c.time,c));
    state.candles=[...map.values()].sort((a,b)=>a.time-b.time).slice(-500);
    state.series.setData(state.candles);
    lockPredictionForCurrentCandle(false);
    updateUI();
    setStatus("Live • polling",true);
    renderHistory();
  }catch(e){console.warn(e)}
}

function startPolling(){
  clearInterval(state.poll);
  poll(); state.poll=setInterval(poll,12000);
}
function bucketTime(ms,sec){ return Math.floor(ms/1000/sec)*sec; }
function applyTick(price, ts){
  if(!Number.isFinite(price)) return;
  const sec=intervalSeconds(state.tf), t=bucketTime(ts,sec);
  let c=state.candles[state.candles.length-1];
  if(!c || c.time!==t){
    const previous=c;
    const prev=previous?.close ?? price;
    if(previous && previous.time < t){
      finalizeSignalAgainstCandle(previous);
    }
    c={time:t,open:prev,high:price,low:price,close:price};
    state.candles.push(c); state.candles=state.candles.slice(-500);
    state.series.update(c);
    lockPredictionForCurrentCandle(false);
  }else{
    c.high=Math.max(c.high,price); c.low=Math.min(c.low,price); c.close=price;
    state.series.update(c);
  }
  updateUI();
}
function startWebsocket(){
  if(state.source==="otc") return;
  if(state.streamMode==="poll" || !state.apiKey) return;
  try{
    if(state.ws) state.ws.close();
    const ws=new WebSocket("wss://ws.twelvedata.com/v1/quotes/price?apikey="+encodeURIComponent(state.apiKey));
    state.ws=ws;
    ws.onopen=()=>{ ws.send(JSON.stringify({action:"subscribe",params:{symbols:state.pair}})); setStatus("Live • streaming",true); };
    ws.onmessage=e=>{
      try{
        const j=JSON.parse(e.data);
        const price=Number(j.price ?? j.p ?? j.data?.[0]?.p);
        const ts=Number(j.timestamp ?? j.t ?? j.data?.[0]?.t ?? Date.now());
        if(price) applyTick(price, ts>1e12?ts:ts*1000);
      }catch{}
    };
    ws.onerror=()=>{ setStatus("Stream unavailable"); startPolling(); };
    ws.onclose=()=>{ if(state.streamMode!=="poll" && state.source==="twelve") startPolling(); };
  }catch{ startPolling(); }
}

function ema(values,n){
  if(values.length<n) return null;
  const k=2/(n+1); let e=values.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<values.length;i++) e=values[i]*k+e*(1-k);
  return e;
}
function rsi(cs,n=14){
  if(cs.length<n+1)return null; let g=0,l=0;
  for(let i=cs.length-n;i<cs.length;i++){const d=cs[i].close-cs[i-1].close;if(d>=0)g+=d;else l-=d;}
  if(l===0)return 100; const rs=(g/n)/(l/n); return 100-100/(1+rs);
}
function atr(cs,n=14){
  if(cs.length<n+1)return null; const tr=[];
  for(let i=1;i<cs.length;i++) tr.push(Math.max(cs[i].high-cs[i].low,Math.abs(cs[i].high-cs[i-1].close),Math.abs(cs[i].low-cs[i-1].close)));
  return tr.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function candlePattern(cs){
  const a=cs.at(-1), b=cs.at(-2), c=cs.at(-3); if(!a||!b)return "No pattern";
  const body=Math.abs(a.close-a.open), range=Math.max(a.high-a.low,1e-9), upper=a.high-Math.max(a.open,a.close), lower=Math.min(a.open,a.close)-a.low;
  if(a.close>b.open && a.open<b.close && a.close>a.open && a.open<=b.close && a.close>=b.open) return "Bullish engulfing";
  if(a.close<b.open && a.open>b.close && a.close<a.open && a.open>=b.close && a.close<=b.open) return "Bearish engulfing";
  if(lower>body*2 && upper<body) return "Bullish rejection";
  if(upper>body*2 && lower<body) return "Bearish rejection";
  if(body/range<0.12) return "Doji / indecision";
  if(c && a.close>b.close && b.close>c.close) return "Three-candle bullish sequence";
  if(c && a.close<b.close && b.close<c.close) return "Three-candle bearish sequence";
  return a.close>a.open?"Bullish candle":"Bearish candle";
}
function scorePrediction(cs, horizon){
  if(cs.length<30)return {dir:"WAIT",confidence:0, reasons:["Need more candles"]};
  const closes=cs.map(x=>x.close), last=cs.at(-1);
  const e9=ema(closes,9), e21=ema(closes,21), rr=rsi(cs), aa=atr(cs);
  let score=0,reasons=[];
  if(e9>e21){score+=2;reasons.push("EMA trend is bullish")} else {score-=2;reasons.push("EMA trend is bearish")}
  if(rr!==null){if(rr>55&&rr<72){score+=1;reasons.push("RSI has bullish momentum")} else if(rr<45&&rr>28){score-=1;reasons.push("RSI has bearish momentum")} else reasons.push("RSI is in a caution zone")}
  const p=candlePattern(cs);
  if(/Bullish/.test(p)){score+=1.5;reasons.push(p)} else if(/Bearish/.test(p)){score-=1.5;reasons.push(p)} else reasons.push(p);
  const recent=cs.slice(-10), hi=Math.max(...recent.map(x=>x.high)), lo=Math.min(...recent.map(x=>x.low));
  if(last.close>(hi+lo)/2) score+=0.7; else score-=0.7;
  // Horizon 2 is deliberately more conservative.
  if(horizon===2) score*=0.86;
  const dir=score>0.75?"UP":score<-0.75?"DOWN":"WAIT";
  const confidence=dir==="WAIT"?50:Math.min(92,Math.round(50+Math.abs(score)*8));
  return {dir,confidence,reasons:[...new Set(reasons)].slice(0,5)};
}
function updateForecast(id,p){
  const el=$(id), strong=el.querySelector("strong"), conf=el.querySelector(".confidence");
  strong.textContent=p.dir; strong.className=p.dir.toLowerCase(); conf.textContent=p.confidence+"%";
}
function buildForecastCandle(base, dir, atrValue, step, tfSeconds){
  const moveBase=Math.max(atrValue || (base.close*0.00025), base.close*0.00008);
  const direction=dir==="UP"?1:dir==="DOWN"?-1:0;
  const move=direction*moveBase*(step===1?0.72:0.52);
  const open=base.close + (step===2 ? direction*moveBase*0.08 : 0);
  const close=open+move;
  const wick=moveBase*0.20;
  return {
    time:base.time + tfSeconds*step,
    open,
    high:Math.max(open,close)+wick,
    low:Math.min(open,close)-wick,
    close
  };
}
function drawPredictionOverlay(p1,p2){
  if(!state.forecastSeries)return;
  const last=state.candles.at(-1);
  if(!last){state.forecastSeries.setData([]);return;}
  const atrValue=atr(state.candles) || Math.abs(last.close-last.open) || last.close*0.0002;
  const sec=intervalSeconds(state.tf);
  const c1=buildForecastCandle(last,p1.dir,atrValue,1,sec);
  const c2=buildForecastCandle(c1,p2.dir,atrValue,2,sec);
  state.forecastSeries.setData(p1.dir==="WAIT" && p2.dir==="WAIT" ? [] : [c1,c2]);
}
function pad2(n){return String(n).padStart(2,"0");}
function formatLocalTime(sec){const d=new Date(sec*1000);return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;}
function updateCandleClock(){
  const el=$("candleCountdown"), times=$("candleTimes"); if(!el||!times)return;
  const sec=intervalSeconds(state.tf), latest=state.candles.at(-1);
  if(!latest){el.textContent="--:--";times.textContent="START — · END —";return;}
  const now=Math.floor(Date.now()/1000), start=latest.time, end=start+sec;
  let remaining=end-now;
  if(remaining<0) remaining=((Math.floor(now/sec)+1)*sec)-now;
  const h=Math.floor(remaining/3600), m=Math.floor((remaining%3600)/60), ss=remaining%60;
  el.textContent=sec>=3600?`${pad2(h)}:${pad2(m)}:${pad2(ss)}`:`${pad2(Math.floor(remaining/60))}:${pad2(ss)}`;
  times.textContent=`START ${formatLocalTime(start)} · END ${formatLocalTime(end)}`;
}
setInterval(updateCandleClock,1000);

function updateUI(){
  updateCandleClock();
  if(!state.candles.length)return;
  const c=state.candles.at(-1), closes=state.candles.map(x=>x.close), e9=ema(closes,9), e21=ema(closes,21), rr=rsi(state.candles), aa=atr(state.candles);
  $("pairLabel").textContent=state.pair; $("price").textContent=c.close.toFixed(state.pair.includes("JPY")?3:5);
  $("ohlc").textContent=`O ${c.open.toFixed(5)}  H ${c.high.toFixed(5)}  L ${c.low.toFixed(5)}  C ${c.close.toFixed(5)}`;
  $("rsi").textContent=rr?rr.toFixed(1):"—"; $("ema9").textContent=e9?e9.toFixed(5):"—"; $("ema21").textContent=e21?e21.toFixed(5):"—"; $("atr").textContent=aa?aa.toFixed(5):"—";
  $("trend").textContent=e9&&e21?(e9>e21?"UP":"DOWN"):"—";
  const p1=state.lockedPrediction?.p1 || {dir:"WAIT",confidence:0,reasons:["Waiting for a new candle"]};
  const p2=state.lockedPrediction?.p2 || {dir:"WAIT",confidence:0,reasons:[]};
  updateForecast("forecast1",p1); updateForecast("forecast2",p2);
  drawPredictionOverlay(p1,p2);
  $("analysisList").innerHTML=p1.reasons.map(x=>`<li>✓ ${x}</li>`).join("");
  const lockEl=$("signalLock");
  if(lockEl) lockEl.textContent=state.lockedPrediction ? `LOCKED • ${formatLocalTime(state.signalCandleTime)}` : "WAITING";
  renderHistory();
}
function runBacktest(){
  const cs=state.candles;if(cs.length<80)return;
  let wins=0,tests=0;
  for(let i=40;i<cs.length-2;i++){
    const hist=cs.slice(0,i+1), p=scorePrediction(hist,1); if(p.dir==="WAIT")continue;
    const actual=cs[i+1].close>cs[i+1].open?"UP":cs[i+1].close<cs[i+1].open?"DOWN":"WAIT";
    if(actual==="WAIT")continue; tests++; if(p.dir===actual)wins++;
  }
  if(tests){const pct=Math.round(wins/tests*100);$("backtestScore").textContent=pct+"%";$("backtestText").textContent=`${wins} correct / ${tests} tested signals (historical sample)`;}
}
async function connect(){
  state.apiKey=$("apiKey").value.trim();
  state.streamMode=$("streamMode").value;
  state.source=$("dataSource").value;
  state.otcFeedUrl=$("otcFeedUrl").value.trim().replace(/\/$/,"");
  localStorage.setItem("awan_td_key",state.apiKey);
  localStorage.setItem("awan_stream",state.streamMode);
  localStorage.setItem("awan_source",state.source);
  localStorage.setItem("awan_otc_feed",state.otcFeedUrl);
  $("settingsModal").classList.add("hidden");
  if(state.ws) try{state.ws.close()}catch{}
  clearInterval(state.poll);
  await loadHistory();
  if(state.source==="twelve"){ startWebsocket(); startPolling(); }
  else { startPolling(); }
}
$("settingsBtn").onclick=()=>{
  $("apiKey").value=state.apiKey;
  $("streamMode").value=state.streamMode;
  $("dataSource").value=state.source;
  $("otcFeedUrl").value=state.otcFeedUrl;
  toggleSourceFields();
  $("settingsModal").classList.remove("hidden");
};
$("closeSettings").onclick=()=>$("settingsModal").classList.add("hidden");
$("saveSettings").onclick=connect;
$("dataSource").onchange=toggleSourceFields;
$("pairSelect").onchange=async e=>{
  state.pair=e.target.value;
  if(state.pair.includes("(OTC)")) state.source="otc";
  $("pairLabel").textContent=state.pair;
  state.lockedPrediction=null; state.signalCandleTime=0;
  toggleSourceFields();
  await loadHistory();
  if(state.source==="twelve") startWebsocket();
};
document.querySelectorAll("#timeframes button").forEach(b=>b.onclick=async()=>{
  document.querySelectorAll("#timeframes button").forEach(x=>x.classList.remove("selected"));
  b.classList.add("selected"); state.tf=b.dataset.tf;
  state.lockedPrediction=null; state.signalCandleTime=0;
  await loadHistory(); if(state.source==="twelve") startWebsocket();
});
$("backtestBtn").onclick=()=>{runBacktest();$("backtestScore").scrollIntoView({behavior:"smooth"})};
$("strategyBtn").onclick=()=>showInfo("Strategy","The engine uses EMA trend, RSI momentum, ATR, candle structure, rejection/engulfing patterns and recent range position. Signals are calculated from completed candles and locked for the active 1-minute candle. This is experimental and not a guaranteed outcome.");
$("aboutBtn").onclick=()=>showInfo("About Awan Prediction AI","Awan Prediction AI uses provider market data and calculates signals locally. Normal forex can use Twelve Data. OTC matching requires a broker/venue-specific feed; TradingView is a charting/data display service, not a Quotex API.");
$("tradingViewBtn").onclick=()=>window.open("https://www.tradingview.com/","_blank","noopener");
$("historyBtn").onclick=()=>{$("historyPanel").classList.toggle("hidden")};
function showInfo(title,body){$("infoTitle").textContent=title;$("infoBody").innerHTML=`<p>${body}</p>`;$("infoModal").classList.remove("hidden")}
$("closeInfo").onclick=()=>$("infoModal").classList.add("hidden");

function toggleSourceFields(){
  const otc=state.source==="otc";
  $("twelveField").classList.toggle("hidden",otc);
  $("otcField").classList.toggle("hidden",!otc);
  $("streamField").classList.toggle("hidden",otc);
}
function lockPredictionForCurrentCandle(force=false){
  if(state.candles.length<31) return;
  const current=state.candles.at(-1);
  const previous=state.candles.slice(0,-1);
  if(!current) return;
  if(!force && state.signalCandleTime===current.time) return;
  const p1=scorePrediction(previous,1), p2=scorePrediction(previous,2);
  state.lockedPrediction={p1,p2};
  state.signalCandleTime=current.time;
  state.lockedAt=Date.now();
  drawPredictionOverlay(p1,p2);
  saveSignalIfNeeded(current,p1);
}
function saveSignalIfNeeded(current,p1){
  if(!p1 || p1.dir==="WAIT") return;
  const key=`${state.source}|${state.pair}|${state.tf}|${current.time}`;
  if(state.history.some(x=>x.key===key)) return;
  state.history.unshift({key,pair:state.pair,tf:state.tf,source:state.source,time:current.time,direction:p1.dir,confidence:p1.confidence,result:"PENDING"});
  state.history=state.history.slice(0,200);
  localStorage.setItem("awan_trade_history",JSON.stringify(state.history));
}
function finalizeSignalAgainstCandle(candle){
  const item=state.history.find(x=>x.pair===state.pair&&x.tf===state.tf&&x.source===state.source&&x.time===candle.time&&x.result==="PENDING");
  if(!item) return;
  item.result=candle.close>candle.open?"WIN":candle.close<candle.open?"LOSS":"DRAW";
  localStorage.setItem("awan_trade_history",JSON.stringify(state.history));
}
function recordResult(key,result){
  const item=state.history.find(x=>x.key===key); if(!item)return;
  item.result=result; localStorage.setItem("awan_trade_history",JSON.stringify(state.history)); renderHistory();
}
function renderHistory(){
  const box=$("historyList"), wins=state.history.filter(x=>x.result==="WIN").length, losses=state.history.filter(x=>x.result==="LOSS").length, pending=state.history.filter(x=>x.result==="PENDING").length;
  if($("winsCount"))$("winsCount").textContent=wins;
  if($("lossesCount"))$("lossesCount").textContent=losses;
  if($("pendingCount"))$("pendingCount").textContent=pending;
  if(!box)return;
  box.innerHTML=state.history.slice(0,30).map(x=>`<div class="history-item"><div><b>${x.pair}</b> <span>${x.tf}</span><small>${formatLocalTime(x.time)} · ${x.direction} · ${x.confidence}%</small></div><div class="history-result ${x.result.toLowerCase()}"><b>${x.result}</b>${x.result==="PENDING"?`<button onclick="recordResult('${x.key}','WIN')">WIN</button><button onclick="recordResult('${x.key}','LOSS')">LOSS</button>`:""}</div></div>`).join("") || `<div class="empty-history">No signals recorded yet.</div>`;
}
async function loadOTCHistory(forceLock=true){
  if(!state.otcFeedUrl){setStatus("Add OTC feed URL");return;}
  try{
    const u=new URL(state.otcFeedUrl);
    const symbol=state.pair.includes("(OTC)") ? state.pair.replace(" (OTC)","").replace("/","")+"_otc" : state.pair;
    u.searchParams.set("symbol",symbol); u.searchParams.set("interval",state.tf);
    const r=await fetch(u); const j=await r.json();
    const vals=(j.values||j.candles||[]).map(v=>({time:Number(v.time||Math.floor(new Date(String(v.datetime||v.time)).getTime()/1000)),open:+(v.open??v.o),high:+(v.high??v.h),low:+(v.low??v.l),close:+(v.close??v.c)})).filter(x=>Number.isFinite(x.time)).sort((a,b)=>a.time-b.time);
    if(!vals.length)throw new Error("No candles returned");
    state.candles=vals.slice(-500); state.series.setData(state.candles); chart.timeScale().fitContent(); state.loaded=true; lockPredictionForCurrentCandle(forceLock); updateUI(); setStatus("OTC feed ready",true); renderHistory();
  }catch(e){setStatus("OTC feed error");console.error(e);alert("OTC feed error: "+e.message)}
}
async function pollOTC(){ await loadOTCHistory(false); }
if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
if(state.apiKey || state.otcFeedUrl){ loadHistory().then(()=>{if(state.source==="twelve"){startWebsocket();startPolling()}else{startPolling()}}); }
toggleSourceFields(); renderHistory();
