## typescript: 1.2.2 published vs 1.3.0 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.2.2 published: INTEL(R) XEON(R) PLATINUM 8573C (5); 1.3.0 checkout: INTEL(R) XEON(R) PLATINUM 8573C (5)

| measure | metric | 1.2.2 published | 1.3.0 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.053 (0.0494–0.0744) | 0.0579 (0.0515–0.0639) | +9% (noise) |
| overhead | plain_p99_ms | 0.206 (0.183–0.244) | 0.197 (0.193–0.201) | -4% (noise) |
| overhead | baton_p50_ms | 0.117 (0.115–0.118) | 0.117 (0.116–0.122) | +0% (noise) |
| overhead | baton_p99_ms | 1.61 (1.43–1.67) | 1.46 (1.41–1.54) | -10% (noise) |
| overhead | added_p50_ms | 0.0642 (0.0422–0.0664) | 0.0592 (0.0538–0.0695) | -8% (noise) |
| overhead | added_p99_ms | 1.37 (1.23–1.47) | 1.26 (1.22–1.34) | -8% (noise) |
| burst | plain_wall_ms | 428 (420–470) | 430 (424–470) | +0% (noise) |
| burst | plain_call_p50_ms | 0.339 (0.336–0.345) | 0.342 (0.339–0.359) | +1% (noise) |
| burst | plain_call_p99_ms | 1.83 (1.75–1.88) | 1.83 (1.69–1.97) | -0% (noise) |
| burst | wall_ms | 1,253 (1,238–1,305) | 1,308 (1,305–1,444) | +4% |
| burst | call_p50_ms | 0.999 (0.957–1.11) | 1 (0.959–1.35) | +0% (noise) |
| burst | call_p99_ms | 3.74 (3.37–4.1) | 3.58 (3.32–4) | -4% (noise) |
| burst | added_call_p50_ms | 0.658 (0.617–0.767) | 0.657 (0.599–1.01) | -0% (noise) |
| burst | added_call_p99_ms | 1.88 (1.55–2.22) | 1.65 (1.4–2.22) | -12% (noise) |
| burst | close_ms | 1.96 (1.8–2.17) | 2.25 (2.17–2.48) | +15% |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 432 (427–488) | 447 (434–451) | +3% (noise) |
| outage_hang | plain_call_p50_ms | 0.348 (0.344–0.359) | 0.355 (0.347–0.357) | +2% (noise) |
| outage_hang | plain_call_p99_ms | 1.64 (1.61–2.09) | 1.72 (1.62–1.88) | +5% (noise) |
| outage_hang | wall_ms | 892 (876–934) | 913 (888–923) | +2% (noise) |
| outage_hang | call_p50_ms | 0.709 (0.696–0.716) | 0.743 (0.731–0.748) | +5% |
| outage_hang | call_p99_ms | 2.6 (2.46–2.74) | 2.53 (2.41–2.6) | -3% (noise) |
| outage_hang | added_call_p50_ms | 0.357 (0.352–0.364) | 0.39 (0.374–0.396) | +9% |
| outage_hang | added_call_p99_ms | 0.853 (0.655–0.992) | 0.795 (0.531–0.986) | -7% (noise) |
| outage_hang | close_ms | 3,001 (3,001–3,002) | 3,002 (3,001–3,002) | +0% (noise) |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 474 (452–496) | 453 (441–464) | -4% (noise) |
| outage_down | plain_call_p50_ms | 0.355 (0.346–0.379) | 0.345 (0.339–0.353) | -3% |
| outage_down | plain_call_p99_ms | 1.92 (1.8–2.25) | 1.76 (1.7–1.94) | -8% |
| outage_down | wall_ms | 898 (886–961) | 953 (920–996) | +6% (noise) |
| outage_down | call_p50_ms | 0.717 (0.707–0.732) | 0.759 (0.742–0.769) | +6% |
| outage_down | call_p99_ms | 2.65 (2.54–3.33) | 2.63 (2.43–2.82) | -0% (noise) |
| outage_down | added_call_p50_ms | 0.368 (0.328–0.386) | 0.413 (0.403–0.419) | +12% |
| outage_down | added_call_p99_ms | 0.741 (0.659–1.12) | 0.877 (0.734–0.929) | +18% (noise) |
| outage_down | close_ms | 1,192 (1,127–1,203) | 1,138 (1,088–1,167) | -5% (noise) |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 25,635,832 (25,618,984–26,150,176) | 23,150,984 (22,693,904–23,176,056) | -10% |
| memory | heap_at_half_bytes | 26,056,016 (26,042,608–26,100,016) | 23,205,376 (23,190,904–23,216,616) | -11% |
| memory | heap_at_end_bytes | 26,184,272 (26,182,288–26,194,032) | 23,260,512 (23,252,560–23,283,032) | -11% |
| memory | growth_per_call_bytes | 12.8 (9.4–14) | 6.35 (3.59–7.77) | -6.45 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,429,656 (26,426,360–26,473,944) | 23,413,312 (23,408,016–23,522,552) | -11% |
| memory_outage | heap_at_half_bytes | 27,614,776 (27,595,976–27,657,864) | 24,686,232 (24,673,344–24,697,248) | -11% |
| memory_outage | heap_at_end_bytes | 27,570,328 (27,559,608–27,613,856) | 24,649,352 (24,643,896–24,657,344) | -11% |
| memory_outage | growth_per_call_bytes | -4.4 (-4.88–-3.64) | -3.69 (-4.57–-2.89) | +0.713 (noise) |
| large_result | plain_p50_ms | 0.0425 (0.0418–0.0443) | 0.0432 (0.0417–0.0438) | +2% (noise) |
| large_result | plain_p99_ms | 0.14 (0.122–0.143) | 0.129 (0.128–0.139) | -8% (noise) |
| large_result | baton_p50_ms | 0.515 (0.515–0.524) | 0.523 (0.516–0.529) | +2% (noise) |
| large_result | baton_p99_ms | 3.48 (3.4–3.55) | 3.55 (3.49–3.57) | +2% |
| large_result | added_p50_ms | 0.473 (0.472–0.479) | 0.48 (0.473–0.487) | +2% |
| large_result | added_p99_ms | 3.34 (3.28–3.41) | 3.42 (3.36–3.43) | +2% |
| large_result | heap_growth_bytes | 721,768 (708,056–725,208) | 712,272 (702,728–736,048) | -1% (noise) |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 218,509,312 (218,161,152–226,615,296) | 204,926,976 (201,977,856–205,168,640) | -6% |
