const CACHE="awan-ai-v3";
const ASSETS=["./","./index.html","./style.css","./app.js","./manifest.webmanifest","./profile.jpg"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener("fetch",e=>{
  if(e.request.url.includes("api.twelvedata.com") || e.request.url.includes("ws.twelvedata.com")) return;
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(x=>{
    const copy=x.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return x;
  }).catch(()=>caches.match("./index.html"))));
});
