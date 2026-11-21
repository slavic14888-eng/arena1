// 3D Arena Mobile — сервер рейтинга. Без зависимостей: нужен только Node.js 16+.
// Запуск:  node server.js   → открой http://IP:8080 (сервер сам раздаёт игру, рейтинг подключится автоматически).
"use strict";
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=+process.env.PORT||8080;
const DATA_FILE=process.env.DATA_FILE||path.join(__dirname,"data.json");
const ONLINE_MS=90e3, TOKEN_MS=90*24*3600e3;

// ---------- хранилище ----------
let db={users:{},tokens:{}};
try{db=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));db.users=db.users||{};db.tokens=db.tokens||{};}catch(e){}
let dirty=false,saving=false;
function save(){dirty=true;}
function flush(){
 if(!dirty||saving)return;saving=true;dirty=false;
 const tmp=DATA_FILE+".tmp";
 fs.writeFile(tmp,JSON.stringify(db),err=>{
  if(err){saving=false;dirty=true;return;}
  fs.rename(tmp,DATA_FILE,e=>{saving=false;if(e)dirty=true;});
 });
}
setInterval(flush,2000);
function flushSync(){try{fs.writeFileSync(DATA_FILE,JSON.stringify(db));}catch(e){}}
for(const sg of["SIGINT","SIGTERM"])process.on(sg,()=>{flushSync();process.exit(0);});

// ---------- утилиты ----------
const now=()=>Date.now();
const hashPw=(pw,salt)=>crypto.scryptSync(pw,salt,32).toString("hex");
const num=(v,mx)=>Math.max(0,Math.min(mx,Math.floor(+v||0)));
const okUser=u=>typeof u==="string"&&/^[a-z0-9_]{3,16}$/.test(u);
function cleanProf(p,old){
 p=p||{};
 const r={rating:num(p.rating,9999),w:num(p.w,9999),l:num(p.l,9999),k:num(p.k,99999),d:num(p.d,99999),m:0};
 r.m=Math.max(num(p.m,99999),r.w+r.l);
 r.color=/^#[0-9a-f]{6}$/i.test(p.color||"")?p.color:(old&&old.color)||"#c0392b";
 r.av=(p.av&&p.av.t==="emo"&&typeof p.av.e==="string")?{t:"emo",e:p.av.e.slice(0,4)}:(old&&old.av)||null;
 return r;
}
// защита от накрутки: матчи/убийства растут только в разумных пределах за один sync
function applyProf(u,np){
 const o=u.prof;
 if(!o){u.prof=np;return;}
 if(np.m<o.m)return;                         // назад не откатываем
 if(np.m-o.m>60||np.k-o.k>600||np.w-o.w>60){return;}
 if(Math.abs(np.rating-o.rating)>400)return;
 u.prof=np;
}
function newToken(user){
 const t=crypto.randomBytes(24).toString("hex");
 db.tokens[t]={u:user,e:now()+TOKEN_MS};save();return t;
}
function userByToken(t){
 const k=db.tokens[t];if(!k)return null;
 if(k.e<now()){delete db.tokens[t];save();return null;}
 return db.users[k.u]?{name:k.u,u:db.users[k.u]}:null;
}
// rate limit
const hits=new Map();
function limited(ip,key,max,win){
 const k=ip+"|"+key,t=now();let h=hits.get(k);
 if(!h||t-h.t>win)h={t,n:0};h.n++;hits.set(k,h);return h.n>max;
}
setInterval(()=>{const t=now();for(const[k,h]of hits)if(t-h.t>120e3)hits.delete(k);},60e3);

// ---------- HTTP ----------
function send(res,code,obj){
 const b=JSON.stringify(obj);
 res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Cache-Control":"no-store"});
 res.end(b);
}
function body(req){
 return new Promise((ok,no)=>{
  let s="";req.on("data",c=>{s+=c;if(s.length>20000){no(new Error("big"));req.destroy();}});
  req.on("end",()=>{try{ok(s?JSON.parse(s):{});}catch(e){no(new Error("json"));}});
  req.on("error",no);
 });
}
function gameFile(){
 try{
  const pref=path.join(__dirname,"game.html");if(fs.existsSync(pref))return pref;
  const l=fs.readdirSync(__dirname).filter(f=>/\.html$/i.test(f));
  if(l.length)return path.join(__dirname,l[0]);
  const up=path.join(__dirname,"..");
  const l2=fs.readdirSync(up).filter(f=>/\.html$/i.test(f));
  if(l2.length)return path.join(up,l2[0]);
 }catch(e){}
 return null;
}
const online=()=>{const t=now();let n=0;for(const k in db.users)if(t-(db.users[k].seen||0)<ONLINE_MS)n++;return n;};

const srv=http.createServer(async(req,res)=>{
 const ip=(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").toString().split(",")[0].trim();
 const url=new URL(req.url,"http://x");
 if(req.method==="OPTIONS"){res.writeHead(204,{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"});return res.end();}
 const p=url.pathname;
 if(!p.startsWith("/api/")){
  if(p==="/health"){res.writeHead(200);return res.end("ok");}
  const f=gameFile();
  if(!f){res.writeHead(404);return res.end("Положи файл игры (.html) рядом с server.js");}
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});
  return fs.createReadStream(f).pipe(res);
 }
 if(limited(ip,"all",240,60e3))return send(res,429,{err:"slow_down"});
 try{
  if(p==="/api/ping")return send(res,200,{ok:true,players:Object.keys(db.users).length,online:online()});
  if(p==="/api/top"){
   const by={r:"rating",k:"k",w:"w"}[url.searchParams.get("by")]||"rating";
   const t=now();
   const L=Object.keys(db.users).map(n=>{const u=db.users[n],q=u.prof;return{user:n,nick:u.nick,av:q.av,color:q.color,r:q.rating,k:q.k,w:q.w,l:q.l,d:q.d,m:q.m,on:t-(u.seen||0)<ONLINE_MS};});
   L.sort((a,b)=>(by==="rating"?b.r-a.r:b[by]-a[by])||b.r-a.r);
   return send(res,200,{top:L.slice(0,100),online:online(),total:L.length});
  }
  if(req.method!=="POST")return send(res,405,{err:"method"});
  const b=await body(req);
  if(p==="/api/register"){
   if(limited(ip,"reg",5,3600e3))return send(res,429,{err:"slow_down"});
   const user=String(b.user||"").toLowerCase();
   if(!okUser(user))return send(res,400,{err:"bad_user"});
   if(typeof b.pass!=="string"||b.pass.length<4||b.pass.length>64)return send(res,400,{err:"bad_pass"});
   if(db.users[user])return send(res,409,{err:"taken"});
   const salt=crypto.randomBytes(16).toString("hex");
   db.users[user]={salt,hash:hashPw(b.pass,salt),nick:String(b.nick||user).slice(0,16),prof:cleanProf(b.prof),created:now(),seen:now()};
   save();
   return send(res,200,{token:newToken(user),prof:db.users[user].prof});
  }
  if(p==="/api/login"){
   if(limited(ip,"login",15,60e3))return send(res,429,{err:"slow_down"});
   const user=String(b.user||"").toLowerCase(),u=db.users[user];
   if(!u)return send(res,404,{err:"nouser"});
   const h=hashPw(String(b.pass||""),u.salt);
   if(!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(u.hash)))return send(res,403,{err:"bad_pass"});
   u.seen=now();save();
   return send(res,200,{token:newToken(user),prof:u.prof,nick:u.nick});
  }
  if(p==="/api/sync"){
   const a=userByToken(String(b.token||""));
   if(!a)return send(res,401,{err:"bad_token"});
   a.u.seen=now();
   if(b.nick)a.u.nick=String(b.nick).slice(0,16);
   if(b.prof)applyProf(a.u,cleanProf(b.prof,a.u.prof));
   save();
   return send(res,200,{ok:true,prof:a.u.prof,online:online()});
  }
  return send(res,404,{err:"not_found"});
 }catch(e){return send(res,e.message==="big"?413:400,{err:e.message||"bad_request"});}
});
srv.listen(PORT,"0.0.0.0",()=>console.log("Arena сервер запущен: http://localhost:"+PORT+"  (данные: "+DATA_FILE+")"));
