# AGENTS.md (wasm/)

`wasm/` — браузерный фронтенд Olaf, библиотеки аудиофингерпринтинга на C/Zig.

**Полный репозиторий присутствует.** Это не изолированный чекаут: рядом лежат нативные исходники
(`src/`, `build.zig`) и `dataset/`. Бинарник `js/olaf.wasm` собирается командой **`zig build web`** (Zig 0.16) в корне репозитория — она обновляет именно этот файл. Не редактируйте бинарники вручную; пересобирайте из источника.

## Нет npm-сборки, есть Zig + node-тесты

- `package.json` существует только для установки `"type": "module"`; зависимостей и скриптов нет — не запускайте `npm install / test / run`.
- Сборка wasm: **`zig build web`** (корень репозитория) → обновляет `wasm/js/olaf.wasm`.
- Проверки выполняются node'ом напрямую, без npm.

## ABI wasm (`js/olaf_wasm.js`) — единственный источник истины

Обработку ABI меняйте только в `js/olaf_wasm.js` (общий для AudioWorklet и node-теста). Текущий набор:
- экспорты: `olaf_fingerprint_match`, `olaf_wasm_describe`, `olaf_wasm_set_visualize`, **`olaf_wasm_set_extract`**, **`olaf_wasm_set_profile`**, `malloc`/`free`, `memory`;
- импортируемые колбэки (`env`): `olaf_fp_matcher_callback`, `olaf_spectrum_callback`, `olaf_event_point_callback`, и теперь — **`olaf_fp_callback(timeIndex1, hashLo, hashHi)`** (настоящие отпечатки `(t1, hash)`, см. `src/olaf_wasm.c:78`).
- Профили: по умолчанию **`demo` = `olaf_config_esp_32()`**; опция `profile:"server"` вызывает `set_profile(1)` → **`olaf_config_default()`** (step 128, 3 EPs per FP), совпадает с серверным индексом. Выбор профиля фиксируется до инициализации (`src/olaf_wasm.c:85`).
- Режим экстракции отпечатков включается `set_extract(1)`; тогда встроенный матчер пропускается, а каждый fingerprint уходит в JS через `onFingerprint({ time_index, hash })` (см. `.kilo/docs/olaf-mic-fingerprint-to-external-server.md`, §4).

## Новые файлы и тесты (текущее состояние)

Клиентская отправка настоящих отпечатков на внешний сервер:
- `js/olaf_windows.js` — режет накопленные отпечатки в скользящие окна.
- `js/olaf_ingest.js` — микрофон → Olaf (`profile:"server"`, экстракция) → скользящие окна **10 с / hop 5 с** → `POST <endpoint>` телом `{ type, sessionId, grid, wallClockMs, fingerprints:[{t1,hash}] }`.
- `feasibility.html` — страница-пробник (endpoint по умолчанию `http://localhost:8920/api/query-hashes`).

Инструменты и тесты (`node …`, запускать из корня репозитория):
- `olaf_wasm_test.mjs` — эталонный node-тест ABI (референс id 1051039).
- **`olaf_fp_extract_test.mjs`** — проверка экстракции отпечатков `(t1, hash)` из wasm.
- **`olaf_windows_test.mjs`** — проверка нарезки окон (`js/olaf_windows.js`).
- `tools/fp_compat_check.mjs` — детерминированная (без LMDB) проверка совместимости хэшей с серверным индексом: hash overlap, постоянный сдвиг `t1`, симуляция матчера.
- `tools/query_hashes_probe.mjs <baseUrl> [audio]` — живой HTTP e2e на боевом Linux-сервере (LMDB под Windows падает на `mdb_env_open`).

## Команды проверки

```bash
zig build web                                  # пересобрать wasm/js/olaf.wasm (Zig 0.16)
node wasm/olaf_wasm_test.mjs                   # эталонный ABI-тест (нужен ffmpeg + dataset)
node wasm/olaf_fp_extract_test.mjs             # экстракция отпечатков из wasm
node wasm/olaf_windows_test.mjs                # нарезка скользящих окон
node wasm/tools/fp_compat_check.mjs            # совместимость хэшей с сервером (без LMDB, детерминированно)
```

## Связка AudioWorklet (не нарушайте порядок загрузки)

- `js/olaf.js` — главный поток: `fetch("olaf.wasm")` (worklet не может `fetch`) плюс
  `audioWorklet.addModule("olaf_processor.js")`, передаёт байты wasm через `processorOptions.wasmBytes`.
- `js/olaf_processor.js` — AudioWorklet (`olaf-processor`): ресемплирует вход в 16 кГц с помощью libsamplerate, затем вызывает Olaf; отчитывается через порт сообщениями `{type:"status"|"grid"|"spectrum"|...}` или объектом совпадения. Вывод `console` из worklet ненадёжен — всё идёт через порт.
- `js/olaf_wasm.js` — единственный источник истины для ABI wasm (см. выше). Обработку ABI меняйте только здесь.
- `js/resample_processor.js` — минимальный автономный worklet, используется только в `resample.html`.
- `js/olaf_spectrogram.js` — рендерер WebGL2 собственных спектров и event points Olaf (требует **WebGL2**).

## Подводные камни

- Аудио — моно 16 кГц; `process()` получает рендер-кванты по 128 сэмплов. Берите свежий
  `new Float32Array(memory.buffer, …)` view на каждом вызове — память wasm может вырасти и отсоединить прежние view.
- `TextDecoder` не гарантирован в `AudioWorkletGlobalScope`; `olaf_wasm.js` откатывается на побайтовый цикл.
- Захват микрофона обязан отключать voice processing (`echoCancellation/noiseSuppression/autoGainControl: false`) — он искажает спектральные пики (см. `index.html`, `spectrogram.html`).
- Референс-трек скомпилирован в wasm; эталонный id 1051039 для node/браузерных тестов.

## Стиль

Табы для отступов, двойные кавычки и комментарии, объясняющие *почему*, а не пересказывающие код (см. `js/olaf_spectrogram.js`). Следуйте стилю окружающего файла.
