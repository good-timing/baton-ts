## typescript: 1.1.0 published vs 1.1.1 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.1.0 published: AMD EPYC 7763 64-Core Processor (5); 1.1.1 checkout: AMD EPYC 7763 64-Core Processor (5)

| measure | metric | 1.1.0 published | 1.1.1 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.114 (0.113–0.117) | 0.118 (0.114–0.119) | +3% |
| overhead | plain_p99_ms | 0.275 (0.273–0.281) | 0.282 (0.279–0.293) | +3% |
| overhead | baton_p50_ms | 0.253 (0.252–0.258) | 0.262 (0.255–0.266) | +3% |
| overhead | baton_p99_ms | 1.83 (1.72–1.88) | 1.8 (1.68–1.93) | -2% (noise) |
| overhead | added_p50_ms | 0.14 (0.136–0.142) | 0.144 (0.141–0.149) | +3% |
| overhead | added_p99_ms | 1.55 (1.44–1.6) | 1.5 (1.4–1.64) | -3% (noise) |
| burst | plain_wall_ms | 754 (732–802) | 752 (737–794) | -0% (noise) |
| burst | plain_call_p50_ms | 0.638 (0.615–0.669) | 0.634 (0.627–0.651) | -1% (noise) |
| burst | plain_call_p99_ms | 2.52 (2.33–2.7) | 2.44 (2.41–2.63) | -3% (noise) |
| burst | wall_ms | 2,142 (2,061–2,196) | 2,215 (2,152–2,304) | +3% |
| burst | call_p50_ms | 1.99 (1.96–2.1) | 2.13 (2.06–2.19) | +7% |
| burst | call_p99_ms | 4.59 (4.32–4.72) | 4.3 (4.26–4.8) | -6% |
| burst | added_call_p50_ms | 1.36 (1.34–1.46) | 1.5 (1.43–1.55) | +10% |
| burst | added_call_p99_ms | 1.98 (1.88–2.3) | 1.85 (1.66–2.18) | -7% |
| burst | close_ms | 2.45 (2.19–3.94) | 3.03 (2.55–3.16) | +24% (noise) |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 784 (782–795) | 766 (760–782) | -2% |
| outage_hang | plain_call_p50_ms | 0.653 (0.636–0.664) | 0.644 (0.641–0.657) | -1% (noise) |
| outage_hang | plain_call_p99_ms | 2.21 (2.1–2.46) | 2.21 (2.15–2.24) | -0% (noise) |
| outage_hang | wall_ms | 1,748 (1,700–1,764) | 1,849 (1,806–1,875) | +6% |
| outage_hang | call_p50_ms | 1.55 (1.52–1.57) | 1.65 (1.61–1.68) | +6% |
| outage_hang | call_p99_ms | 3.5 (3.34–3.65) | 3.64 (3.51–3.72) | +4% (noise) |
| outage_hang | added_call_p50_ms | 0.904 (0.869–0.919) | 0.993 (0.968–1.04) | +10% |
| outage_hang | added_call_p99_ms | 1.23 (1.19–1.3) | 1.48 (1.3–1.56) | +20% |
| outage_hang | close_ms | 3,000 (3,000–3,001) | 3,001 (3,001–3,002) | +0% |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 760 (751–817) | 750 (742–776) | -1% |
| outage_down | plain_call_p50_ms | 0.626 (0.622–0.638) | 0.628 (0.619–0.634) | +0% (noise) |
| outage_down | plain_call_p99_ms | 2.2 (2.02–2.73) | 2.1 (2.02–2.28) | -5% (noise) |
| outage_down | wall_ms | 1,776 (1,728–1,857) | 1,847 (1,792–1,894) | +4% (noise) |
| outage_down | call_p50_ms | 1.59 (1.54–1.63) | 1.65 (1.61–1.7) | +4% |
| outage_down | call_p99_ms | 3.48 (3.37–3.86) | 3.53 (3.47–3.58) | +1% (noise) |
| outage_down | added_call_p50_ms | 0.949 (0.915–1.01) | 1.02 (0.991–1.07) | +7% |
| outage_down | added_call_p99_ms | 1.28 (0.919–1.58) | 1.37 (1.29–1.51) | +7% (noise) |
| outage_down | close_ms | 703 (702–703) | 703 (703–703) | -0% (noise) |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 25,485,672 (25,467,296–25,498,392) | 22,487,256 (22,471,984–22,505,880) | -12% |
| memory | heap_at_half_bytes | 25,928,568 (25,918,736–25,954,936) | 22,971,864 (22,939,304–22,982,464) | -11% |
| memory | heap_at_end_bytes | 25,982,800 (25,965,552–26,011,560) | 23,038,168 (23,019,192–23,042,984) | -11% |
| memory | growth_per_call_bytes | 5.66 (3.7–6.57) | 6.82 (5.57–9.1) | +1.16 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,184,712 (26,168,080–26,268,224) | 23,221,376 (23,176,608–23,301,736) | -11% |
| memory_outage | heap_at_half_bytes | 27,414,160 (27,397,848–27,419,144) | 24,453,640 (24,389,072–24,479,888) | -11% |
| memory_outage | heap_at_end_bytes | 27,366,232 (27,350,416–27,371,240) | 24,417,336 (24,361,992–24,440,536) | -11% |
| memory_outage | growth_per_call_bytes | -4.79 (-5.43–-4.74) | -3.64 (-5.19–-2.01) | +1.15 (noise) |
| large_result | plain_p50_ms | 0.0885 (0.0863–0.0914) | 0.089 (0.0855–0.0898) | +1% (noise) |
| large_result | plain_p99_ms | 0.216 (0.206–0.221) | 0.213 (0.207–0.217) | -1% (noise) |
| large_result | baton_p50_ms | 0.669 (0.656–0.679) | 0.685 (0.679–0.686) | +2% |
| large_result | baton_p99_ms | 3.54 (3.52–3.88) | 3.59 (3.5–3.92) | +1% (noise) |
| large_result | added_p50_ms | 0.578 (0.57–0.591) | 0.595 (0.593–0.597) | +3% |
| large_result | added_p99_ms | 3.33 (3.31–3.68) | 3.37 (3.29–3.7) | +1% (noise) |
| large_result | heap_growth_bytes | 756,632 (740,568–785,592) | 748,112 (686,928–762,928) | -1% (noise) |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 217,305,088 (217,128,960–218,750,976) | 201,093,120 (200,355,840–207,622,144) | -7% |
