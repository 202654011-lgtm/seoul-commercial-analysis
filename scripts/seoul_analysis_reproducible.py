# -*- coding: utf-8 -*-
"""서울시 생활인구 기반 상가 공급 분석: QGIS Python 콘솔에서 exec(open(..., encoding='utf-8').read())로 실행.
원본 CSV + 25개 자치구 SHP -> GeoPackage / GeoJSON / 순위 CSV / 검증 TXT.
기존 output을 덮어쓰지 않도록 모든 산출물에 'repro_' 접두어를 사용.
"""

# =================== 1. 사용자 설정 (이 부분만 수정) ===================
from pathlib import Path
# None이면 이 파일의 상위 폴더(프로젝트 루트)를 자동으로 사용.
# QGIS 콘솔에서 exec(open(...).read()) 방식으로 실행할 경우 __file__이 없으므로 아래 경로 지정 권장.
BASE_DIR = Path(r'D:\Seoul_Commercial_Analysis')
DATA_DIR_NAME = 'data_raw'
OUTPUT_DIR_NAME = 'output'
BOUNDARY_FILE = 'bnd_sigungu_11_2025_2Q.shp'
STORE_FILE = '소상공인시장진흥공단_상가(상권)정보_서울_202606.csv'
POPULATION_FILE = '자치구별 서울 생활인구(250m) 일별집계표.csv'
STORE_ENCODING = 'utf-8-sig'
POP_ENCODING = 'cp949'
ANALYSIS_YEAR_MONTH = '202606'
EXPECTED_DISTRICTS = 25
POPULATION_UNIT = 10000
TOP_N = 5
BOUNDARY_NAME_FIELD = 'SIGUNGU_NM'
STORE_NAME_FIELD = '시군구명'
STORE_ID_FIELD = '상가업소번호'
POP_DATE_FIELD = '기준일ID'
POP_NAME_FIELD = '시구명'
POP_FIELDS = {'POP_TOTAL': '총생활인구수', 'POP_DAY': '주간인구수(09~18)', 'POP_NIGHT': '야간인구수(19~08)'}
OUTPUT_PREFIX = 'repro_'
# =====================================================================

import csv
from collections import Counter, defaultdict
from statistics import mean
from qgis.core import (QgsVectorLayer, QgsProject, QgsFeature, QgsField,
                       QgsVectorFileWriter, QgsWkbTypes)
from qgis.PyQt.QtCore import QVariant

root = Path(BASE_DIR).expanduser().resolve()
raw = root / DATA_DIR_NAME
out = root / OUTPUT_DIR_NAME
out.mkdir(parents=True, exist_ok=True)


def check_file(path):
    if not path.is_file():
        raise FileNotFoundError(f'입력 파일 없음: {path}')
    return path


def require_fields(actual, required, label):
    missing = set(required) - set(actual)
    if missing:
        raise ValueError(f'{label} 필드 누락: {sorted(missing)} / 실제 필드: {list(actual)}')


def read_rows(path, encoding, fields, label):
    with open(check_file(path), 'r', encoding=encoding, newline='') as f:
        reader = csv.DictReader(f)
        require_fields(reader.fieldnames or [], fields, label)
        for row in reader:
            yield row


def number(value, label):
    try:
        n = float(str(value).replace(',', '').strip())
        if not (n > 0 and n < float('inf')):
            raise ValueError()
        return n
    except (TypeError, ValueError):
        raise ValueError(f'생활인구 값이 유효하지 않음: {label}={value!r}')


# 2. 경계 파일 읽기 (QGIS 설치 필수)
shape_path = check_file(raw / BOUNDARY_FILE)
boundary = QgsVectorLayer(str(shape_path), '원본_서울자치구경계', 'ogr')
if not boundary.isValid():
    raise RuntimeError(f'SHP 로드 실패: {shape_path} / SHP·SHX·DBF 기본 파일명 확인')
require_fields([f.name() for f in boundary.fields()], [BOUNDARY_NAME_FIELD], '경계')
features = list(boundary.getFeatures())
names = [str(f[BOUNDARY_NAME_FIELD]).strip() for f in features]
if len(features) != EXPECTED_DISTRICTS or len(set(names)) != EXPECTED_DISTRICTS:
    raise ValueError(f'경계 자치구 수/중복 확인 필요: 행={len(features)}, 고유={len(set(names))}')
name_set = set(names)

# 3. 상가 수 집계: 원본의 자치구명으로 25개 지역만 집계
shops = Counter()
store_ids = set()
store_rows = 0
excluded_stores = Counter()
for row in read_rows(raw / STORE_FILE, STORE_ENCODING, [STORE_NAME_FIELD, STORE_ID_FIELD], '상가'):
    store_rows += 1
    name = (row[STORE_NAME_FIELD] or '').strip()
    if name not in name_set:
        excluded_stores[name or '(빈 자치구명)'] += 1
        continue
    store_id = (row[STORE_ID_FIELD] or '').strip()
    if not store_id:
        raise ValueError(f'상가업소번호가 빈 행 발견: {store_rows}행')
    if store_id in store_ids:
        raise ValueError(f'상가업소번호 중복 발견: {store_id}')
    store_ids.add(store_id)
    shops[name] += 1
if set(shops) != name_set:
    raise ValueError(f'상가 데이터에 없는 자치구: {sorted(name_set - set(shops))}')

# 4. 2026년 6월 일별 생활인구 집계 (서울시 합계 행은 제외)
pops = defaultdict(lambda: defaultdict(list))
days = defaultdict(set)
for row in read_rows(raw / POPULATION_FILE, POP_ENCODING,
                     [POP_DATE_FIELD, POP_NAME_FIELD, *POP_FIELDS.values()], '생활인구'):
    date = str(row[POP_DATE_FIELD]).strip()
    if not date.startswith(ANALYSIS_YEAR_MONTH):
        continue
    name = (row[POP_NAME_FIELD] or '').strip()
    if name not in name_set:
        continue
    if len(date) != 8 or not date.isdigit():
        raise ValueError(f'날짜 형식 오류: {date}')
    if date in days[name]:
        raise ValueError(f'동일 자치구·날짜 중복: {name} {date}')
    days[name].add(date)
    for out_field, csv_field in POP_FIELDS.items():
        pops[name][out_field].append(number(row[csv_field], f'{name} {date} {csv_field}'))
if set(pops) != name_set:
    raise ValueError(f'생활인구 자료가 없는 자치구: {sorted(name_set - set(pops))}')
day_counts = {name: len(days[name]) for name in names}
if len(set(day_counts.values())) != 1:
    raise ValueError(f'자치구별 날짜 수가 다름: {day_counts}')
if next(iter(day_counts.values())) != 30 and ANALYSIS_YEAR_MONTH == '202606':
    raise ValueError(f'2026년 6월 자료는 30일이어야 함: {day_counts}')

# 5. 공급 지표 및 순위 산정
records = {}
for name in names:
    record = {'SIGUNGU_NM': name, 'SHOP_COUNT': shops[name]}
    for field in POP_FIELDS:
        record[field] = mean(pops[name][field])
    record['SHOP_PER_10K'] = shops[name] / record['POP_TOTAL'] * POPULATION_UNIT
    record['SHOP_DAY_10K'] = shops[name] / record['POP_DAY'] * POPULATION_UNIT
    record['SHOP_NIGHT_10K'] = shops[name] / record['POP_NIGHT'] * POPULATION_UNIT
    record['DAY_NIGHT_DIFF'] = record['SHOP_DAY_10K'] - record['SHOP_NIGHT_10K']
    records[name] = record
for metric, rank in [('SHOP_PER_10K', 'RANK_TOTAL'),
                     ('SHOP_DAY_10K', 'RANK_DAY'),
                     ('SHOP_NIGHT_10K', 'RANK_NIGHT')]:
    ordered = sorted(names, key=lambda name: (records[name][metric], name))
    for position, name in enumerate(ordered, 1):
        records[name][rank] = position
for name in names:
    r = records[name]
    r['CHANGE_DAY'] = r['RANK_DAY'] - r['RANK_TOTAL']
    r['CHANGE_NIGHT'] = r['RANK_NIGHT'] - r['RANK_TOTAL']

# 6. 결과 CSV (엑셀에서 한글 열기 쉬운 UTF-8 BOM)
field_names = ['SIGUNGU_NM', 'SHOP_COUNT', 'POP_TOTAL', 'POP_DAY', 'POP_NIGHT',
               'SHOP_PER_10K', 'SHOP_DAY_10K', 'SHOP_NIGHT_10K', 'DAY_NIGHT_DIFF',
               'RANK_TOTAL', 'RANK_DAY', 'RANK_NIGHT', 'CHANGE_DAY', 'CHANGE_NIGHT']
csv_path = out / f'{OUTPUT_PREFIX}seoul_scenario_rank_comparison.csv'
with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=field_names)
    writer.writeheader()
    writer.writerows(records[name] for name in sorted(names, key=lambda n: records[n]['RANK_TOTAL']))

# 7. 결과 공간 레이어 생성 및 저장
geometry = 'MultiPolygon' if QgsWkbTypes.isMultiType(boundary.wkbType()) else 'Polygon'
layer = QgsVectorLayer(f'{geometry}?crs={boundary.crs().authid()}', '재현_생활인구_상가공급', 'memory')
if not layer.isValid():
    raise RuntimeError('결과 메모리 레이어 생성 실패')
provider = layer.dataProvider()
int_fields = {'SHOP_COUNT', 'RANK_TOTAL', 'RANK_DAY', 'RANK_NIGHT', 'CHANGE_DAY', 'CHANGE_NIGHT'}
provider.addAttributes([QgsField(k, QVariant.String if k == 'SIGUNGU_NM' else
                                  QVariant.Int if k in int_fields else QVariant.Double)
                        for k in field_names])
layer.updateFields()
new_features = []
for src in features:
    name = str(src[BOUNDARY_NAME_FIELD]).strip()
    f = QgsFeature(layer.fields())
    f.setGeometry(src.geometry())
    f.setAttributes([records[name][k] for k in field_names])
    new_features.append(f)
ok, added = provider.addFeatures(new_features)
layer.updateExtents()
if not ok or layer.featureCount() != EXPECTED_DISTRICTS:
    raise RuntimeError(f'공간 레이어 피처 추가 실패: {provider.lastError()}')


def save_vector(destination, driver, layer_name=None):
    opts = QgsVectorFileWriter.SaveVectorOptions()
    opts.driverName = driver
    opts.fileEncoding = 'UTF-8'
    if layer_name:
        opts.layerName = layer_name
    opts.actionOnExistingFile = QgsVectorFileWriter.CreateOrOverwriteFile
    result = QgsVectorFileWriter.writeAsVectorFormatV3(
        layer, str(destination), QgsProject.instance().transformContext(), opts)
    if result[0] != QgsVectorFileWriter.NoError:
        raise RuntimeError(f'{destination} 저장 실패: {result}')


gpkg_path = out / f'{OUTPUT_PREFIX}population_shop_analysis.gpkg'
geojson_path = out / f'{OUTPUT_PREFIX}seoul_shop_supply.geojson'
save_vector(gpkg_path, 'GPKG', 'seoul_supply')
save_vector(geojson_path, 'GeoJSON')

# 8. 안정성 검증 지표 및 로그
baseline = set(sorted(names, key=lambda n: records[n]['RANK_TOTAL'])[:TOP_N])
day = set(sorted(names, key=lambda n: records[n]['RANK_DAY'])[:TOP_N])
night = set(sorted(names, key=lambda n: records[n]['RANK_NIGHT'])[:TOP_N])
stable = [n for n in names if records[n]['RANK_TOTAL'] == records[n]['RANK_DAY'] == records[n]['RANK_NIGHT']]

def spearman(rank):
    n = len(names)
    d2 = sum((records[name]['RANK_TOTAL'] - records[name][rank]) ** 2 for name in names)
    return 1 - 6 * d2 / (n * (n * n - 1))

lines = [
    '서울시 생활인구 기반 상가 공급 분석: 재현성 검증',
    f'분석 기간: {ANALYSIS_YEAR_MONTH}',
    f'자치구 수: {len(names)}',
    f'생활인구 일수: {sorted(set(day_counts.values()))}',
    f'상가 CSV 전체 행: {store_rows:,}',
    f'25개 자치구에 매칭된 상가: {sum(shops.values()):,}',
    f'제외된 상가 행(자치구 불일치/빈 값): {sum(excluded_stores.values()):,}',
    f'제외 행 분류: {dict(excluded_stores)}',
    f'기준 상위 {TOP_N}: {sorted(baseline)}',
    f'주간 상위 {TOP_N}: {sorted(day)}',
    f'야간 상위 {TOP_N}: {sorted(night)}',
    f'주간 상위 {TOP_N} 일치율: {len(baseline & day) / TOP_N:.1%}',
    f'야간 상위 {TOP_N} 일치율: {len(baseline & night) / TOP_N:.1%}',
    f'주간 Spearman 순위상관: {spearman("RANK_DAY"):.4f}',
    f'야간 Spearman 순위상관: {spearman("RANK_NIGHT"):.4f}',
    f'세 시나리오 순위 완전 유지 지역: {sorted(stable)}',
    '주의: 생활인구 대비 상가 수가 적다는 것이 곧 상권의 경영 취약성을 의미하지는 않음.',
    '주의: 이전 결과와 수치가 다르면 원본 파일/필터/중복 처리 기준을 대조해야 함.',
]
log_path = out / f'{OUTPUT_PREFIX}validation_report.txt'
log_path.write_text('\n'.join(lines) + '\n', encoding='utf-8-sig')
project = QgsProject.instance()
for old in list(project.mapLayers().values()):
    if old.name() == layer.name():
        project.removeMapLayer(old.id())
project.addMapLayer(layer)
print('\n'.join(lines))
print('\n완료! 출력:', csv_path, gpkg_path, geojson_path, log_path, sep='\n')
