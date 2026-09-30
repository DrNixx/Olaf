# Olaf: микрофон → извлечение отпечатков → мэтчинг на внешнем сервере

> Конспект, приведённый к текущему состоянию (ветка `wasm_fp_extractor`, полный репозиторий).
> Фаза feasibility была завершена в изолированном чекауте фронтенда; затем работа переехала
> в проект с полным репозиторием Olaf (`src/`, `build.zig`, `dataset/`) и реализована по **Пути A**
> (настоящие отпечатки из wasm) + новый REST-эндпоинт на сервере. Ниже — история feasibility,
> затем фактическая реализация и статус проверок.

## 1. Цель

Используя браузерный фронтенд Olaf:

1. захватить окружающий звук с микрофона;
2. извлечь пару `(t1, hash)` — отпечаток (fingerprint);
3. отправить её на мэтчинг на внешний сервер.

Задача формулировалась в два этапа: сначала определить возможность «в принципе», затем реализовывать.

## 2. История feasibility-фазы (исходные факты)

> Раздел сохранён как история первоначального исследования; часть пунктов ниже **устарела**
> после переезда в полный репозиторий и помечена явно.

### 2.1. Захват микрофона и прогон Olaf уже работали

- `index.html:118-152` и `spectrogram.html:178-186` реализуют путь:
  `getUserMedia` (voice processing принудительно выключен) → `createOlafNode()` → AudioWorklet
  `olaf-processor` → ресемплинг в 16 кГц → `olaf.match()`.
- Обязательные constraints микрофона (`echoCancellation/noiseSuppression/autoGainControl: false`) —
  voice processing искажает спектральные пики, по которым строится фингерпринт.

### 2.2. В старом wasm не было экстрактора отпечатков (устарело)

В исходном `js/olaf.wasm` экспортировались только `_initialize`, `free`, `malloc`, `memory`,
`olaf_fingerprint_match`, `olaf_wasm_describe`, `olaf_wasm_set_visualize`; импортируемые колбэки —
`olaf_fp_matcher_callback`, `olaf_spectrum_callback`, `olaf_event_point_callback`. Функции, отдающей пару
`(t1, hash)`, в ABI **не было**. Это и есть причина, по которой feasibility-фаза рассматривала Пути A/B/C.

### 2.3. Апстримный экстрактор существовал, но не был проброшен (устарело)

В `src/olaf_fp_extractor.h/.c` — `struct fingerprint`, `olaf_fp_extractor_extract(...)`,
`olaf_fp_extractor_hash(f)`; кастомный мост `src/olaf_wasm.c` эти функции наружу не выставлял. **Сейчас** они проброшены (см. §4).

### 2.4. Чего не было в исходном чекауте (устарело)

В изолированном фронтенд-чекауте отсутствовали `src/`, `build.zig` и `dataset/`. **Сейчас** работа ведётся
в полном репозитории на ветке `wasm_fp_extractor`: нативные исходники, `build.zig` и `zig build web` присутствуют.

## 3. Вывод feasibility (исторический)

| Подзадача | Возможность | Основание |
|---|---|---|
| Извлечь звук с микрофона | ✅ да | AudioWorklet + libsamplerate |
| Ресемплинг в 16 кГц + прогон Olaf | ✅ да | worklet `olaf-processor` |
| Отправить данные на внешний сервер | ✅ да | реализованный пробник + smoke-тест |
| Сформировать `(t1, hash)` в браузере | ❌ нет **на старом** wasm → решено Пути A (см. §4) | не было экспорта экстрактора (§2.2) |

Итог feasibility: цель достижима; единственная реально извлекаемая наружу полезная нагрузка на том
старом бинаре — event points (`olaf_event_point_callback`). Это вход для спаривания в отпечатки, а не сами хэши. **Дальше реализован Путь A** (экспорт настоящих отпечатков), что сделало отправку EP-батчей ненужной.

## 4. Реализация — текущее состояние (Путь A выбран и выполнен)

### 4.1. Настоящие отпечатки из wasm (`src/olaf_wasm.c`)

Выбран **Путь A**: `src/olaf_wasm.c` отдаёт настоящие отпечатки `(t1, hash)` через:

- импортируемый колбэк
  ```c
  __attribute__((import_module("env"), import_name("olaf_fp_callback")))
  void olaf_fp_callback(int timeIndex1, uint32_t hashLo, uint32_t hashHi);   // src/olaf_wasm.c:78
  ```
- экспорт `__attribute__((export_name("olaf_wasm_set_extract")))` → `void olaf_wasm_set_extract(int on)` (`src/olaf_wasm.c:114`).

При включённом режиме экстракции встроенный матчер пропускается, а каждый сформированный отпечаток
вызывает `olaf_fp_callback(f.timeIndex1, (uint32_t)hash, (uint32_t)(hash >> 32))` (`src/olaf_wasm.c:217`).

JS-ABI в `wasm/js/olaf_wasm.js`: опция `onFingerprint`, колбэк
```js
olaf_fp_callback(timeIndex1, hashLo, hashHi) { onFingerprint?.({ time_index: timeIndex1, hash: (hashHi >>> 0)*0x100000000 + (hashLo>>>0) }); }   // js/olaf_wasm.js:80
```

### 4.2. Профиль `server` (`src/olaf_wasm.c`)

- Экспорт `__attribute__((export_name("olaf_wasm_set_profile")))` → `void olaf_wasm_set_profile(int on)` (`src/olaf_wasm.c:127`).
- **Профиль `server`** = `olaf_config_default()` (step 128, 3 EPs per FP) — совпадает с конфигом серверного индекса. Выбор профиля фиксируется до инициализации; после init конфигурация неизменна (`src/olaf_wasm.c:85`).
- **Профиль по умолчанию `demo`** = `olaf_config_esp_32()` — не изменён (совместимость со старыми демо).

## 5. Совместимость хэшей с сервером подтверждена детерминированно (без LMDB)

Инструмент: **`node wasm/tools/fp_compat_check.mjs`** (`wasm/tools/fp_compat_check.mjs`). Он доказывает совместимость тремя независимыми способами и завершается `exit 0`, только если все три условия держатся; иначе — JSON-диагностика с разбивкой overlap / shift / alignment.

Результаты (PASS):
- **hash overlap = 413/425 (97%)** — доля общих хэшей относительно CLI-индекса, ≥ порога 95%.
- **сдвиг `t1` = константа +1**, coverage ≈ 100% по однозначным парам; дрейфа нет. Негативный контроль (инъекция дрейфа) валит тест — т.е. проверка чувствительна именно к постоянному сдвигу, а не к разбросу.
- **симуляция матчера** (`searchRange = 5`, `timeDiff = ((q_t1 - r_t1)) >> 2` в точности как `src/olaf_fp_matcher.c:147`) → **max bucket ≈ 417**, что ≫ `minMatchCount`.

Известные и безобидные расхождения (не ломают мэтчинг):
- **Сдвиг `t1` на +1 блок** относительно CLI. Причина — `olaf_stream_processor.c` и `olaf_wasm.c` размечают «блок» по-разному; матчер таллит пары по разностям (`(q_t1 - r_t1) >> 2`) в бакеты, поэтому постоянный сдвиг не влияет на `match_count`.
- **Хвост**: CLI делает финальный сброс после цикла — `src/olaf_stream_processor.c:193-195` (`if(eventPoints != NULL && eventPointIndex > 0) olaf_fp_extractor_extract(...)`), а wasm — нет; это ~3% отпечатков на хвосте. Для окна 10 с / hop 5 с не критично. Опциональный follow-up: экспорт «flush» в wasm для точного паритета по хвосту.

## 6. Клиент (браузер)

- **`wasm/js/olaf_ingest.js`** — `startIngest({ endpoint, windowSeconds = 10, hopSeconds = 5, onStatus })`:
  микрофон → Olaf в режиме экстракции (`profile: "server"`, `onFingerprint`) → накопление отпечатков →
  скользящие окна **10 с / hop 5 с** → `POST <endpoint>` телом
  ```json
  { "type": "fingerprints", "sessionId": "...", "grid": {...}, "wallClockMs": 1234, "fingerprints": [ {"t1": ..., "hash": ...} ] }   // js/olaf_ingest.js:42
  ```
- **`wasm/js/olaf_windows.js`** — режет накопленные отпечатки на скользящие окна (используется `olaf_ingest.js`).
- **`wasm/feasibility.html`** — страница-пробник; endpoint по умолчанию `http://localhost:8920/api/query-hashes` (`feasibility.html:23`), Start/Stop, счётчики.

## 7. Сервер (REST)

Новый REST-эндпоинт **`POST /api/query-hashes[?identifier=<label>]`** с телом
```json
{ "fingerprints": [ {"t1": ..., "hash": ...} ] }   // cli/rest/olaf_rest.zig:6, olaf_cli_rest_backend.zig:174
```

- Матчит переданные хэши по LMDB. Ядро — **`olaf_fp_matcher_match_hash(Olaf_FP_Matcher*, int queryFingerprintT1, uint64_t queryFingerprintHash)`** (`src/olaf_fp_matcher.h:89`, реализация `src/olaf_fp_matcher.c:218`).
- Сессия — **`pub fn queryHashes(allocator, config, hashes) ![]Match`** (`cli/olaf_cli_session.zig:399`).
- REST-слой (`cli/rest/`) остаётся std-only; биндинг к сессии — `LocalBackend.queryHashes` в `cli/olaf_cli_rest_backend.zig`.

## 8. Эксплуатация (живой режим)

- Сервер использует **`fragment_duration_in_seconds: 10`** — индекс состоит из 10-с клипов прямого эфира, id = unix-время момента записи.
- Рекомендован **`min_match_count ≈ 20`** для живого режима (комфортно выше `olaf_config_default().minMatchCount`).
- Сигнал доходит до клиента через спутник с задержкой ~30 с, поэтому к моменту запроса клипа он уже проиндексирован — окно «запрос раньше индекса» не возникает.

## 9. Статус проверок (честно)

- **Локальные node-тесты PASS**: `wasm/olaf_wasm_test.mjs`, `wasm/olaf_fp_extract_test.mjs`,
  `wasm/olaf_windows_test.mjs`, `node wasm/tools/fp_compat_check.mjs`.
- **`zig build`**, **`zig build -Dcore=true`** и REST unit-тесты PASS (кроме предсуществующего Windows-only провала `listenExclusive`).
- **Живой HTTP e2e НЕ выполнялся в этом окружении.** Причина: LMDB под Windows падает на `mdb_env_open` (`ERROR_INVALID_NAME`) — это предсуществующая проблема, не связанная с текущими правками. Живой e2e выполняется на боевом Linux-сервере; для этого есть пробник **`wasm/tools/query_hashes_probe.mjs <baseUrl> [audio]`**.
  > Важно: в этом документе и отчётах НЕ утверждается, что живой e2e пройден — он не прогонялся здесь.

## 10. Разделение на upstream-able vs форк-специфичное (минимизация расхождения с upstream)

**Upstream-able** (чистое расширение ABI/матчера, не зависит от особенностей форка):
- колбэк отпечатков `olaf_fp_callback(timeIndex1, hashLo, hashHi)` + экспорт `olaf_wasm_set_extract`;
- ядро матчинга по хэшу **`olaf_fp_matcher_match_hash(...)`** (`src/olaf_fp_matcher.h/.c`).

**Форк-специфичное** (зависит от инфраструктуры этого проекта):
- профиль `server` — экспорт `olaf_wasm_set_profile`;
- REST-эндпоинт `/api/query-hashes`, сессия `queryHashes`.

Разделение позволяет держать ядро совместимым с upstream, а «серверную» обвязку изолировать в слое CLI/REST.

## 11. Ключевые ссылки на код (текущее состояние)

- `src/olaf_wasm.c:78` — импорт `olaf_fp_callback`; `:114` экспорт `set_extract`; `:127` экспорт `set_profile`.
- `wasm/js/olaf_wasm.js:80,90,94` — JS ABI (`onFingerprint`, `profile:"server" → set_profile(1)`, `set_extract`).
- `src/olaf_fp_matcher.h:89` / `.c:218` — `olaf_fp_matcher_match_hash`.
- `cli/rest/olaf_rest.zig:6, olaf_cli_rest_api.zig:23` — маршрут `/api/query-hashes`; `cli/olaf_cli_rest_backend.zig:169` — биндинг.
- `wasm/js/olaf_ingest.js`, `wasm/js/olaf_windows.js`, `wasm/tools/fp_compat_check.mjs`, `wasm/tools/query_hashes_probe.mjs`.
