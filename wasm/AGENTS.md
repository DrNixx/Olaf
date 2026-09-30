# AGENTS.md

`wasm/` — это браузерный фронтенд Olaf, библиотеки аудиофингерпринтинга на C/Zig.
В этом чекауте присутствует только фронтенд: нативные исходники (`src/`, `build.zig`),
`dataset/` и git-репозиторий находятся в родительском проекте и здесь **отсутствуют**.
Файлы ссылаются на `../dataset/queries/…`, `src/olaf_fp_ref_mem.h` и `zig build …`,
которых в этом дереве нет — не «чините» эти пути, они относятся к родительскому репозиторию.

## Нет сборки, нет пакетов

- `package.json` существует только для установки `"type": "module"`; зависимостей и скриптов
  нет. Не запускайте `npm install` / `npm test` / `npm run …`.
- `js/olaf.wasm` (настоящий WASM-бинарник) собирается командой `zig build web` в корне
  Zig-репозитория. `js/libsamplerate.worklet.js` — вендорный минифицированный бандл
  `@alexanderolsen/libsamplerate-js` 2.1.2 (~2 МБ, одна строка). Ни один из них не
  редактируйте вручную; пересобирайте/заменяйте в источнике.

## Тесты

- Node-интеграционный тест — прогоняет `js/olaf.wasm` через тот же загрузчик, что и
  AudioWorklet:
  `node olaf_wasm_test.mjs`   (запускать из `wasm/`; либо `node wasm/olaf_wasm_test.mjs`).
  Требует `ffmpeg` в `PATH` и запрос `../dataset/queries/1051039_34s-54s.mp3`
  (скачивается через `zig build test`). Проверяет: ссылка **1051039** совпадает,
  детерминированный LCG-шум даёт ноль совпадений, и каждая event point равна своему
  спектральному бину на своём блоке/частоте. При провале — код возврата 1 + JSON `FAIL …`.
- Браузерные тесты `test.html`, `spectrogram.html`, `resample.html` требуют настоящего
  HTTP-сервера **с корнем в родительском проекте** (не `file://`): они используют ES-модули,
  AudioWorklet и абсолютные URL `/dataset/…`. Поднимите сервер от родительского корня и
  откройте, например, `/wasm/test.html`.
- `test.html` и `spectrogram.html` публикуют машинно-читаемое состояние для харнесса
  chrome-devtools-MCP через `evaluate_script`: `window.__olaf_done`, `window.__olaf_error`,
  а также `__olaf_results` (test.html) / `__olaf_matches` + `__olaf_alignment`
  (spectrogram.html). Опрашивайте их вместо парсинга DOM.
- `olaf_spectrogram.js` требует **WebGL2**.

## Связка (не нарушайте порядок загрузки)

- `js/olaf.js` — главный поток: `fetch("olaf.wasm")` (worklet не может `fetch`) плюс
  `audioWorklet.addModule("olaf_processor.js")`, и передаёт байты wasm через
  `processorOptions.wasmBytes`.
- `js/olaf_processor.js` — AudioWorklet (`olaf-processor`): ресемплирует вход в 16 кГц
  с помощью libsamplerate, затем вызывает `olaf.match()`; отчитывается через порт
  сообщениями `{type:"status"|"grid"|"spectrum"}` или объектом совпадения. Вывод `console`
  из worklet ненадёжен — всё идёт через порт.
- `js/olaf_wasm.js` — единственный источник истины для ABI wasm, общий для worklet и
  node-теста: WASI-шим, колбэки `env` (`olaf_fp_matcher_callback`, `olaf_spectrum_callback`,
  `olaf_event_point_callback`), экспорты (`olaf_fingerprint_match`, `olaf_wasm_describe`,
  `olaf_wasm_set_visualize`, `malloc`/`free`, `memory`). Обработку ABI меняйте только здесь.
- `js/resample_processor.js` — минимальный автономный worklet `resample-processor`,
  используемый только в `resample.html`; не связан с worklet фингерпринтинга.
- `js/olaf_spectrogram.js` — рендерер WebGL2 для собственных спектров и event points Olaf.

## Подводные камни

- Аудио — моно 16 кГц; `process()` получает рендер-кванты по 128 сэмплов. Берите свежий
  `new Float32Array(memory.buffer, …)` view на каждом вызове — память wasm может вырасти и
  отсоединить прежние view.
- `TextDecoder` не гарантирован в `AudioWorkletGlobalScope`; `olaf_wasm.js` откатывается на
  побайтовый цикл.
- Захват микрофона обязан отключать voice processing
  (`echoCancellation/noiseSuppression/autoGainControl: false`) — он искажает спектральные
  пики, по которым строится фингерпринт (см. `index.html`, `spectrogram.html`).
- Референс-трек скомпилирован в wasm; он ровно один (id 1051039).

## Стиль

Табы для отступов, двойные кавычки и комментарии, объясняющие *почему*, а не пересказывающие
код (см. `js/olaf_spectrogram.js`). Следуйте стилю окружающего файла.
