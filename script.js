
"use strict";

// 데이터 파일 경로: 웹 폴더 기준 상대경로
const DATA_PATH = {
    geojson: "./data/seoul_shop_supply.geojson",
    ranking: "./data/seoul_shop_supply_ranking.csv"
};

const TOP_N = 5;

// 숫자 출력
const fmt = (value, digits = 0) =>
    Number(value).toLocaleString("ko-KR", {
        maximumFractionDigits: digits
    });

// CSV 파싱: 따옴표 및 쉼표 처리
function parseCSV(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (ch === '"') {
            if (quoted && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if (ch === "," && !quoted) {
            row.push(cell);
            cell = "";
        } else if ((ch === "\n" || ch === "\r") && !quoted) {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(cell);
            if (row.some(v => v.trim())) rows.push(row);
            row = [];
            cell = "";
        } else {
            cell += ch;
        }
    }

    row.push(cell);
    if (row.some(v => v.trim())) rows.push(row);

    const headers = rows.shift().map(v =>
        v.replace(/^\uFEFF/, "").trim()
    );

    return rows.map(values =>
        Object.fromEntries(
            headers.map((key, i) => [key, values[i] ?? ""])
        )
    );
}

function safeText(value) {
    return String(value ?? "").replace(
        /[&<>"']/g,
        ch => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[ch]
    );
}

async function init() {
    const [geoResponse, csvResponse] = await Promise.all([
        fetch(DATA_PATH.geojson),
        fetch(DATA_PATH.ranking)
    ]);

    if (!geoResponse.ok || !csvResponse.ok) {
        throw new Error("분석 데이터 파일을 불러오지 못했습니다.");
    }

    const geojson = await geoResponse.json();
    const ranking = parseCSV(await csvResponse.text())
        .map(row => ({
            ...row,
            RANK: Number(row.RANK),
            SHOP_COUNT: Number(row.SHOP_COUNT),
            POP_TOTAL: Number(row.POP_TOTAL),
            POP_DAY: Number(row.POP_DAY),
            POP_NIGHT: Number(row.POP_NIGHT),
            SHOP_PER_10K: Number(row.SHOP_PER_10K)
        }))
        .sort((a, b) => a.RANK - b.RANK);

    if (!geojson.features?.length || !ranking.length) {
        throw new Error("분석 데이터가 비어 있습니다.");
    }

    const byDistrict = new Map(
        ranking.map(row => [row.DISTRICT.trim(), row])
    );

    // 통계 카드
    document.getElementById("district-count").textContent =
        `${ranking.length}개`;

    document.getElementById("shortage-count").textContent =
        `${Math.min(TOP_N, ranking.length)}개`;

    document.getElementById("total-shops").textContent =
        fmt(ranking.reduce((sum, row) =>
            sum + row.SHOP_COUNT, 0
        ));

    // 순위표 생성
    const tbody = document.getElementById("ranking-body");

    ranking.forEach(row => {
        const tr = document.createElement("tr");

        [
            row.RANK,
            row.DISTRICT,
            fmt(row.SHOP_COUNT),
            fmt(row.POP_TOTAL, 1),
            fmt(row.SHOP_PER_10K, 2)
        ].forEach(value => {
            const td = document.createElement("td");
            td.textContent = value;
            tr.appendChild(td);
        });

        if (row.RANK <= TOP_N) {
            tr.style.backgroundColor = "#fff0ed";
            tr.style.fontWeight = "bold";
        }

        tbody.appendChild(tr);
    });

    // Leaflet 지도 생성
    const map = L.map("map", {
        scrollWheelZoom: false
    });

    const geoLayer = L.geoJSON(geojson, {
        style: feature => {
            const name = String(
                feature.properties.SIGUNGU_NM ?? ""
            ).trim();

            const row = byDistrict.get(name);
            const shortage = row && row.RANK <= TOP_N;

            return {
                color: "#555555",
                weight: 1,
                fillColor: shortage ? "#d73027" : "#d9d9d9",
                fillOpacity: 0.85
            };
        },

        onEachFeature: (feature, layer) => {
            const name = String(
                feature.properties.SIGUNGU_NM ?? ""
            ).trim();

            const row = byDistrict.get(name);

            layer.bindTooltip(name, {sticky: true});

            layer.on("click", () => {
                if (!row) {
                    document.getElementById(
                        "district-details"
                    ).textContent =
                        `${name}: 분석 데이터를 찾지 못했습니다.`;
                    return;
                }

                const status = row.RANK <= TOP_N
                    ? "상대적 상가 공급 부족 상위 5개 지역"
                    : "기타 지역";

                document.getElementById(
                    "district-details"
                ).innerHTML = `
                    <h3>${safeText(name)}</h3>
                    <p><strong>공급 부족 순위:</strong>
                    ${fmt(row.RANK)}위 / ${ranking.length}개</p>
                    <p><strong>상가 수:</strong>
                    ${fmt(row.SHOP_COUNT)}개</p>
                    <p><strong>생활인구:</strong>
                    ${fmt(row.POP_TOTAL, 1)}명</p>
                    <p><strong>주간 생활인구:</strong>
                    ${fmt(row.POP_DAY, 1)}명</p>
                    <p><strong>야간 생활인구:</strong>
                    ${fmt(row.POP_NIGHT, 1)}명</p>
                    <p><strong>생활인구 1만 명당 상가 수:</strong>
                    ${fmt(row.SHOP_PER_10K, 2)}개</p>
                    <p><strong>분류:</strong>
                    ${safeText(status)}</p>
                `;
            });
        }
    }).addTo(map);

    map.fitBounds(geoLayer.getBounds(), {
        padding: [20, 20]
    });

    // 범례
    const legend = L.control({position: "bottomright"});

    legend.onAdd = () => {
        const div = L.DomUtil.create("div", "map-legend");
        div.style.cssText =
            "background:white;padding:12px;border-radius:6px;" +
            "box-shadow:0 2px 8px #999;font-size:12px;";

        div.innerHTML = `
            <strong>상대적 공급 수준</strong>
            <div style="margin-top:8px">
                <span style="color:#d73027">■</span>
                공급 부족 상위 ${TOP_N}개
            </div>
            <div>
                <span style="color:#d9d9d9">■</span>
                기타 지역
            </div>
        `;
        return div;
    };

    legend.addTo(map);

    console.log("웹지도 데이터 연결 완료");
    console.log("자치구 수:", ranking.length);
    console.log("지도 경계 수:", geojson.features.length);
}

init().catch(error => {
    console.error(error);
    document.getElementById("district-details").textContent =
        "데이터 로딩 오류: " + error.message;
});
