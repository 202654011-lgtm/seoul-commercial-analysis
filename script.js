"use strict";
const PATH = {geojson:"./data/seoul_shop_supply.geojson",ranking:"./data/seoul_shop_supply_ranking.csv"};
const TOP_N=5;
const colors=["#b91c1c","#ef8354","#f5d36b","#9dcbb3","#287d74"];
const fmt=(v,d=0)=>Number(v).toLocaleString("ko-KR",{maximumFractionDigits:d});
const escapeHTML=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function parseCSV(text){
  const rows=[];let row=[],cell="",quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===","&&!quoted){row.push(cell);cell="";}
    else if((c==="\n"||c==="\r")&&!quoted){if(c==="\r"&&text[i+1]==="\n")i++;row.push(cell);cell="";if(row.some(x=>x.trim()))rows.push(row);row=[];}
    else cell+=c;
  }
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
  if(!rows.length)return [];
  const headers=rows.shift().map(x=>x.replace(/^\uFEFF/,"").trim());
  return rows.map(values=>Object.fromEntries(headers.map((h,i)=>[h,values[i]??""])));
}
async function main(){
  if(typeof L==="undefined")throw new Error("지도 라이브러리를 불러오지 못했습니다.");
  const responses=await Promise.all([fetch(PATH.geojson),fetch(PATH.ranking)]);
  if(responses.some(r=>!r.ok))throw new Error("data 폴더의 GeoJSON 또는 CSV 파일을 확인해 주세요.");
  const geojson=await responses[0].json();
  const raw=parseCSV(await responses[1].text());
  const rows=raw.map(r=>({
    DISTRICT:String(r.DISTRICT??"").trim(), SHOP_COUNT:Number(r.SHOP_COUNT),
    POP_TOTAL:Number(r.POP_TOTAL),POP_DAY:Number(r.POP_DAY),POP_NIGHT:Number(r.POP_NIGHT),
    SHOP_PER_10K:Number(r.SHOP_PER_10K)
  }));
  if(!rows.length||!geojson.features?.length)throw new Error("분석 데이터가 비어 있습니다.");
  if(rows.some(r=>!r.DISTRICT||r.SHOP_COUNT<0||r.POP_TOTAL<=0||r.POP_DAY<=0||r.POP_NIGHT<=0))throw new Error("CSV 열 이름이나 생활인구 값을 확인해 주세요.");
  rows.forEach(r=>{
    r.total=r.SHOP_COUNT/r.POP_TOTAL*10000;
    r.day=r.SHOP_COUNT/r.POP_DAY*10000;
    r.night=r.SHOP_COUNT/r.POP_NIGHT*10000;
    r.diff=r.day-r.night;
  });
  const byName=new Map(rows.map(r=>[r.DISTRICT,r]));
  const totalShops=rows.reduce((s,r)=>s+r.SHOP_COUNT,0);
  const totalPop=rows.reduce((s,r)=>s+r.POP_TOTAL,0);
  const citySupply=totalShops/totalPop*10000;
  document.getElementById("district-count").textContent=rows.length+"개";
  document.getElementById("shortage-count").textContent=Math.min(TOP_N,rows.length)+"개";
  document.getElementById("total-shops").textContent=fmt(totalShops);
  document.getElementById("avg-supply").textContent=fmt(citySupply,2)+"개";

  const map=L.map("map",{scrollWheelZoom:false});
  const layers=new Map();let selectedName=null,mode="total",ranked=[];
  const config={
    total:{name:"전체",title:"자치구별 상가 공급 수준",desc:"전체 평균 생활인구 기준 상가 공급 수준입니다. 붉을수록 공급 지표가 낮습니다.",metric:"1만 명당 상가 수",unit:"개",legend:"전체 공급 수준"},
    day:{name:"주간",title:"주간 생활인구 기반 상가 공급 수준",desc:"주간 평균 생활인구 대비 상가 수입니다. 붉을수록 주간 공급 지표가 낮습니다.",metric:"주간 1만 명당 상가 수",unit:"개",legend:"주간 공급 수준"},
    night:{name:"야간",title:"야간 생활인구 기반 상가 공급 수준",desc:"야간 평균 생활인구 대비 상가 수입니다. 붉을수록 야간 공급 지표가 낮습니다.",metric:"야간 1만 명당 상가 수",unit:"개",legend:"야간 공급 수준"},
    diff:{name:"주간·야간 차이",title:"주간·야간 상가 공급 지표 차이",desc:"주간 공급 지표 − 야간 공급 지표입니다. 음수(붉은색)는 주간 지표가 더 낮고, 양수(초록색)는 야간 지표가 더 낮음을 뜻합니다.",metric:"주간−야간 차이",unit:"개",legend:"주간−야간 차이"}
  };
  const getName=feature=>String(feature.properties?.SIGUNGU_NM??"").trim();
  function getLevel(r){if(!r)return -1;const index=ranked.findIndex(x=>x.DISTRICT===r.DISTRICT);return Math.min(4,Math.floor(index/Math.ceil(ranked.length/5)));}
  function style(feature){const r=byName.get(getName(feature));return {color:"#ffffff",weight:1.5,fillColor:colors[getLevel(r)]??"#cbd5e1",fillOpacity:.88};}
  const geoLayer=L.geoJSON(geojson,{
    style,
    onEachFeature(feature,layer){
      const name=getName(feature);layer.bindTooltip(name||"지역명 없음",{sticky:true});
      if(byName.has(name))layers.set(name,layer);
      layer.on("mouseover",()=>{if(selectedName!==name)layer.setStyle({weight:3,color:"#334155"});});
      layer.on("mouseout",()=>{if(selectedName!==name)geoLayer.resetStyle(layer);});
      layer.on("click",()=>selectDistrict(name));
    }
  }).addTo(map);
  map.fitBounds(geoLayer.getBounds(),{padding:[20,20]});
  const legend=L.control({position:"bottomright"});
  legend.onAdd=()=>{const div=L.DomUtil.create("div","legend");div.id="map-legend";return div;};
  legend.addTo(map);
  function rankFor(r){return ranked.findIndex(x=>x.DISTRICT===r.DISTRICT)+1;}
  function selectDistrict(name){
    const r=byName.get(name),box=document.getElementById("district-details");
    if(!r){box.textContent=name+" 지역의 분석 데이터를 찾지 못했습니다.";return;}
    selectedName=name;
    geoLayer.resetStyle();
    const layer=layers.get(name);
    if(layer){layer.setStyle({color:"#172554",weight:4,fillOpacity:1});layer.bringToFront();}
    const rank=rankFor(r),shortage=rank<=TOP_N;
    const label=mode==="diff"?"주간 지표가 더 낮은 순위":"공급 지표가 낮은 순위";
    box.innerHTML=`<h3>${escapeHTML(name)}</h3>
      <p><span class="status">${mode==="diff"?(r.diff<0?"주간 지표가 더 낮음":r.diff>0?"야간 지표가 더 낮음":"주간·야간 지표 동일"):(shortage?"상대적 공급 지표 하위 5개":"공급 수준 비교 대상")}</span></p>
      <div class="details-grid">
      <div class="metric"><small>${label}</small><strong>${fmt(rank)} / ${rows.length}위</strong></div>
      <div class="metric"><small>선택 지도 지표</small><strong>${fmt(r[mode],2)}개</strong></div>
      <div class="metric"><small>상가 수</small><strong>${fmt(r.SHOP_COUNT)}개</strong></div>
      <div class="metric"><small>전체 평균 생활인구</small><strong>${fmt(r.POP_TOTAL,1)}명</strong></div>
      <div class="metric"><small>주간 생활인구</small><strong>${fmt(r.POP_DAY,1)}명</strong></div>
      <div class="metric"><small>야간 생활인구</small><strong>${fmt(r.POP_NIGHT,1)}명</strong></div>
      <div class="metric"><small>주간 공급 지표</small><strong>${fmt(r.day,2)}개</strong></div>
      <div class="metric"><small>야간 공급 지표</small><strong>${fmt(r.night,2)}개</strong></div>
      <div class="metric"><small>주간−야간 차이</small><strong>${fmt(r.diff,2)}개</strong></div>
      </div><p style="font-size:13px;color:#64748b;margin-bottom:0">공급 지표 단위: 생활인구 1만 명당 상가 수. 차이도 동일 단위입니다.</p>`;
  }
  function update(modeNext){
    mode=modeNext;
    ranked=[...rows].sort((a,b)=>a[mode]-b[mode]||a.DISTRICT.localeCompare(b.DISTRICT,"ko"));
    const c=config[mode];
    document.getElementById("map-title").textContent=c.title;
    document.getElementById("map-description").textContent=c.desc;
    document.getElementById("ranking-title").textContent=`서울시 25개 자치구 ${c.name} 지표 순위`;
    document.getElementById("ranking-metric-heading").textContent=c.metric;
    document.getElementById("ranking-description").textContent=mode==="diff"?"1위는 주간 지표가 야간보다 가장 낮은 자치구입니다. 행을 클릭하면 지도에서 확인할 수 있습니다.":"1위는 해당 시간대 생활인구 대비 상가 수가 가장 적은 자치구입니다. 행을 클릭하면 지도에서 확인할 수 있습니다.";
    document.getElementById("chart-title").textContent=mode==="diff"?"주간 지표가 야간보다 가장 낮은 5개 자치구":`${c.name} 공급 지표 하위 5개 자치구`;
    document.getElementById("chart-description").textContent=mode==="diff"?"음수 값이 클수록 주간 공급 지표가 야간보다 더 낮습니다.":"해당 시간대 생활인구 1만 명당 상가 수가 낮은 순서입니다.";
    document.querySelectorAll(".mode-btn").forEach(btn=>{const active=btn.dataset.mode===mode;btn.classList.toggle("active",active);btn.setAttribute("aria-pressed",String(active));});
    geoLayer.setStyle(style);
    const labels=mode==="diff"?["주간 지표 매우 낮음","주간 지표 낮음","차이 중간","야간 지표 낮음","야간 지표 매우 낮음"]:["매우 낮음","낮음","보통","높음","매우 높음"];
    document.getElementById("map-legend").innerHTML=`<strong>${c.legend}</strong>`+labels.map((label,i)=>`<div class="legend-line"><span class="swatch" style="background:${colors[i]}"></span>${label}</div>`).join("")+`<small>25개 구를 지표 순위별 5개씩 분류</small>`;
    const top=ranked.slice(0,TOP_N);
    const maxAbs=Math.max(...top.map(r=>Math.abs(r[mode])),1);
    document.getElementById("shortage-chart").innerHTML=top.map(r=>`<div class="chart-row"><strong>${escapeHTML(r.DISTRICT)}</strong><div class="bar-bg"><div class="bar" style="width:${Math.max(2,100*Math.abs(r[mode])/maxAbs)}%"></div></div><strong>${fmt(r[mode],2)}개</strong></div>`).join("");
    const tbody=document.getElementById("ranking-body");tbody.replaceChildren();
    ranked.forEach((r,i)=>{
      const tr=document.createElement("tr");if(i<TOP_N)tr.className="shortage";
      [i+1,r.DISTRICT,fmt(r.SHOP_COUNT),fmt(mode==="day"?r.POP_DAY:mode==="night"?r.POP_NIGHT:r.POP_TOTAL,1),fmt(r[mode],2)]
        .forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td);});
      tr.addEventListener("click",()=>{selectDistrict(r.DISTRICT);const layer=layers.get(r.DISTRICT);if(layer){map.fitBounds(layer.getBounds(),{padding:[40,40],maxZoom:12});document.getElementById("map").scrollIntoView({behavior:"smooth",block:"center"});}});
      tbody.appendChild(tr);
    });
    document.getElementById("conclusion-text").textContent=mode==="diff"?
      `주간−야간 공급 지표가 낮은 순서의 5개 자치구는 ${top.map(r=>r.DISTRICT).join("·")}입니다. 음수는 주간 공급 지표가 야간보다 낮다는 뜻이며, 공급 부족을 확정하는 의미는 아닙니다.`:
      `${c.name} 생활인구 1만 명당 상가 수 기준, ${top.map(r=>r.DISTRICT).join("·")}가 상대적 공급 지표 하위 ${top.length}개 자치구로 나타났습니다. 추가적인 생활권 수요 조사를 위한 후보 지역입니다.`;
    selectDistrict(selectedName&&byName.has(selectedName)?selectedName:top[0].DISTRICT);
  }
  document.querySelectorAll(".mode-btn").forEach(btn=>btn.addEventListener("click",()=>update(btn.dataset.mode)));
  update("total");
}
main().catch(error=>{console.error(error);document.getElementById("district-details").innerHTML=`<div class="error">데이터 로딩 오류: ${escapeHTML(error.message)}</div>`;});
