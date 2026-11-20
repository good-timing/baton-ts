## typescript: 1.3.1 published vs 1.3.2 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.3.1 published: AMD EPYC 7763 64-Core Processor (5); 1.3.2 checkout: AMD EPYC 7763 64-Core Processor (5)

| measure | metric | 1.3.1 published | 1.3.2 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.113 (0.113–0.116) | 0.116 (0.115–0.12) | +2% (noise) |
| overhead | plain_p99_ms | 0.281 (0.271–0.294) | 0.282 (0.273–0.307) | +0% (noise) |
| overhead | baton_p50_ms | 0.254 (0.252–0.256) | 0.261 (0.256–0.263) | +3% |
| overhead | baton_p99_ms | 1.79 (1.72–1.89) | 1.76 (1.7–1.83) | -2% (noise) |
| overhead | added_p50_ms | 0.14 (0.138–0.143) | 0.143 (0.141–0.147) | +3% |
| overhead | added_p99_ms | 1.51 (1.42–1.62) | 1.49 (1.42–1.52) | -1% (noise) |
| burst | plain_wall_ms | 749 (719–751) | 739 (730–830) | -1% (noise) |
| burst | plain_call_p50_ms | 0.617 (0.603–0.63) | 0.629 (0.62–0.68) | +2% (noise) |
| burst | plain_call_p99_ms | 2.3 (2.14–2.62) | 2.49 (2.43–2.82) | +8% (noise) |
| burst | wall_ms | 2,119 (2,094–2,155) | 2,217 (2,191–2,277) | +5% |
| burst | call_p50_ms | 1.95 (1.92–1.96) | 1.95 (1.94–2.16) | -0% (noise) |
| burst | call_p99_ms | 4.68 (4.57–4.96) | 4.55 (4.4–4.71) | -3% |
| burst | added_call_p50_ms | 1.33 (1.3–1.35) | 1.32 (1.31–1.48) | -1% (noise) |
| burst | added_call_p99_ms | 2.37 (2.26–2.48) | 1.97 (1.87–2.12) | -17% |
| burst | close_ms | 2.53 (2.35–2.66) | 2.45 (2.44–2.79) | -3% (noise) |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 775 (754–838) | 770 (762–783) | -1% (noise) |
| outage_hang | plain_call_p50_ms | 0.629 (0.625–0.687) | 0.641 (0.634–0.656) | +2% (noise) |
| outage_hang | plain_call_p99_ms | 2.23 (2.12–2.83) | 2.19 (2.13–2.35) | -2% (noise) |
| outage_hang | wall_ms | 1,750 (1,724–1,765) | 1,844 (1,813–1,860) | +5% |
| outage_hang | call_p50_ms | 1.54 (1.53–1.56) | 1.64 (1.63–1.66) | +7% |
| outage_hang | call_p99_ms | 3.62 (3.41–3.63) | 3.55 (3.5–3.64) | -2% (noise) |
| outage_hang | added_call_p50_ms | 0.904 (0.852–0.928) | 1.01 (0.977–1.02) | +11% |
| outage_hang | added_call_p99_ms | 1.25 (0.802–1.39) | 1.34 (1.21–1.51) | +7% (noise) |
| outage_hang | close_ms | 3,001 (3,001–3,002) | 3,001 (3,001–3,002) | +0% (noise) |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 756 (742–782) | 762 (753–775) | +1% (noise) |
| outage_down | plain_call_p50_ms | 0.614 (0.609–0.635) | 0.629 (0.615–0.639) | +2% (noise) |
| outage_down | plain_call_p99_ms | 2.28 (2.16–2.66) | 2.2 (2.17–2.28) | -4% (noise) |
| outage_down | wall_ms | 1,772 (1,734–1,806) | 1,869 (1,832–1,886) | +5% |
| outage_down | call_p50_ms | 1.56 (1.54–1.58) | 1.66 (1.63–1.68) | +7% |
| outage_down | call_p99_ms | 3.64 (3.55–4.14) | 3.54 (3.49–3.65) | -3% |
| outage_down | added_call_p50_ms | 0.926 (0.922–0.969) | 1.03 (1.01–1.06) | +11% |
| outage_down | added_call_p99_ms | 1.38 (1.2–1.66) | 1.34 (1.21–1.48) | -3% (noise) |
| outage_down | close_ms | 703 (703–703) | 703 (703–703) | +0% (noise) |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 25,677,208 (25,658,016–25,680,880) | 23,176,776 (23,166,512–23,185,176) | -10% |
| memory | heap_at_half_bytes | 26,158,608 (26,123,632–26,179,968) | 23,212,128 (23,197,560–23,217,832) | -11% |
| memory | heap_at_end_bytes | 26,196,472 (26,176,152–26,219,096) | 23,285,544 (23,266,360–23,299,792) | -11% |
| memory | growth_per_call_bytes | 4.61 (3.53–5.25) | 7.57 (4.85–8.9) | +2.96 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,406,232 (26,377,528–26,506,928) | 23,530,520 (23,435,472–23,547,944) | -11% |
| memory_outage | heap_at_half_bytes | 27,625,376 (27,620,864–27,659,048) | 24,685,112 (24,675,488–24,710,472) | -11% |
| memory_outage | heap_at_end_bytes | 27,593,832 (27,574,272–27,611,880) | 24,660,256 (24,651,120–24,661,304) | -11% |
| memory_outage | growth_per_call_bytes | -4.64 (-4.72–-3.15) | -2.44 (-5.02–-2.03) | +2.2 (noise) |
| large_result | plain_p50_ms | 0.0871 (0.0859–0.0875) | 0.0876 (0.087–0.09) | +1% |
| large_result | plain_p99_ms | 0.214 (0.206–0.234) | 0.202 (0.199–0.224) | -6% |
| large_result | baton_p50_ms | 0.68 (0.675–0.686) | 0.689 (0.683–0.69) | +1% |
| large_result | baton_p99_ms | 3.58 (3.55–3.6) | 3.78 (3.72–3.9) | +6% |
| large_result | added_p50_ms | 0.592 (0.587–0.598) | 0.6 (0.596–0.603) | +1% |
| large_result | added_p99_ms | 3.36 (3.34–3.39) | 3.58 (3.51–3.68) | +6% |
| large_result | heap_growth_bytes | 755,736 (734,856–760,040) | 696,128 (685,152–721,208) | -8% |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 218,353,664 (217,935,872–218,681,344) | 204,087,296 (203,317,248–209,481,728) | -7% |
