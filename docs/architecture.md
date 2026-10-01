<!-- Сгенерировано. Правьте генератор: src/backend/research/docs-generate.ts
     и перегенерируйте: node --env-file=.env --import=tsx src/backend/research/docs-generate.cli.ts -->

# Архитектура бэкенда

Часть сгенерирована, часть — решение. Ответственности слоёв здесь нет
намеренно: они не измеряются, они объявляются, и объявлять их должен
владелец. Всё, что ниже прочитано из кода, разойтись с ним не может.

## Слои

`вход` — рёбра, входящие в слой, `выход` — исходящие. Рёбра внутри слоя
не считаются: слой, разговаривающий сам с собой, не имеет более широкой
границы, чем та, что у него реально есть.

| слой | файлов | вход | выход | род |
|---|---|---|---|---|
| `types` | 4 | 76 | 3 | сквозной лист |
| `errors` | 3 | 18 | 0 | сквозной лист |
| `config` | 13 | 81 | 5 | сквозной лист |
| `instruments` | 3 | 8 | 2 | сквозной лист |
| `db` | 4 | 30 | 2 | ядро |
| `market` | 15 | 26 | 36 | ядро |
| `indicators` | 21 | 22 | 29 | ядро |
| `strategies` | 11 | 44 | 6 | ядро |
| `signals` | 8 | 15 | 13 | ядро |
| `history` | 11 | 13 | 28 | ядро |
| `outcomes` | 3 | 4 | 11 | ядро |
| `performance` | 6 | 6 | 4 | ядро |
| `analysis` | 2 | 4 | 5 | ядро |
| `backtest` | 14 | 23 | 28 | ядро |
| `services` | 6 | 9 | 40 | составляющий |
| `api` | 25 | 12 | 39 | составляющий |
| `research` | 42 | 0 | 116 | составляющий |
| `observability` | 6 | 18 | 3 | сквозной лист |

### Куда каждый слой импортирует

- `types` → `indicators` (2), `signals` (1)
- `config` → `instruments` (2), `strategies` (1), `types` (2)
- `instruments` → `config` (1), `db` (1)
- `db` → `config` (1), `observability` (1)
- `market` → `config` (14), `errors` (12), `observability` (2), `types` (8)
- `indicators` → `config` (7), `db` (1), `errors` (1), `observability` (3), `types` (17)
- `strategies` → `db` (2), `types` (4)
- `signals` → `config` (8), `db` (1), `indicators` (1), `observability` (1), `types` (2)
- `history` → `config` (7), `db` (3), `errors` (1), `market` (7), `observability` (5), `signals` (1), `types` (4)
- `outcomes` → `config` (4), `db` (1), `signals` (3), `types` (3)
- `performance` → `db` (1), `outcomes` (3)
- `analysis` → `config` (2), `db` (2), `types` (1)
- `backtest` → `config` (14), `indicators` (2), `market` (5), `observability` (1), `signals` (2), `types` (4)
- `services` → `analysis` (3), `config` (3), `db` (2), `history` (7), `indicators` (7), `market` (3), `observability` (1), `signals` (6), `strategies` (3), `strategy` (2), `types` (3)
- `api` → `config` (9), `db` (1), `errors` (4), `history` (3), `indicators` (3), `instruments` (4), `market` (9), `observability` (2), `services` (2), `signals` (1), `types` (1)
- `research` → `backtest` (23), `config` (4), `db` (10), `indicators` (6), `observability` (1), `performance` (6), `strategies` (39), `types` (27)
- `observability` → `config` (1), `db` (2)

## Циклы

Между слоями: нет.

Внутри слоя: есть.

### Внутри слоя: backtest/walk-forward.ts → backtest/walk-forward.plan.ts

Цикл внутри слоя — другой дефект, чем слой, дотянувшийся куда нельзя:
здесь два модуля зависят друг от друга, и порядок их загрузки определяет,
что у кого окажется. Слой при этом остаётся достижимым, поэтому ни граф
слоёв, ни проверка достижимости его не показывают.

## Объявленные рёбра, которых нет в коде

Найдено: **3**. Ни одно не разрешено объявлением:
список ниже выведен из данных, а не восстановлен из текста отчёта.

- `types/analysis.ts` → `indicators/indicator.service.ts` — «types» объявлен с доступом к [ничего] и не объявлен с доступом к «indicators»
- `types/analysis.ts` → `signals/signal.types.ts` — «types» объявлен с доступом к [ничего] и не объявлен с доступом к «signals»
- `types/analysis.ts` → `indicators/divergence.service.ts` — «types» объявлен с доступом к [ничего] и не объявлен с доступом к «indicators»

## Зашитый рынок

Упоминаний в комментариях (записи измерений): 100.

Строковых литералов в коде, разрешённый слой: 26.

Строковых литералов в коде, домен: **0**.


Ноль в домене — это не «мы не нашли», а «проверка не может не найти»:
архитектурный lint объявляет, где символ читать можно, и любое другое
чтение попадает в список выше.
