## typescript: 1.2.1 published vs 1.2.2 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. The exception is a measure's 'limits': over 'repeats' runs of that measure alone, each named metric's median must be under its limit. scripts/check_bench_limit.py runs and checks them. A measure's 'noise_floor' gives, per metric and SDK, the change between runs of one version that is still noise. Median (lowest–highest) of 5, 5 runs.

CPU: 1.2.1 published: AMD EPYC 7763 64-Core Processor (5); 1.2.2 checkout: AMD EPYC 7763 64-Core Processor (5)

| measure | metric | 1.2.1 published | 1.2.2 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.116 (0.114–0.116) | 0.118 (0.117–0.118) | +2% |
| overhead | plain_p99_ms | 0.287 (0.277–0.333) | 0.3 (0.287–0.308) | +4% (noise) |
| overhead | baton_p50_ms | 0.258 (0.253–0.26) | 0.263 (0.257–0.271) | +2% |
| overhead | baton_p99_ms | 1.85 (1.8–1.91) | 1.77 (1.69–1.96) | -4% |
| overhead | added_p50_ms | 0.142 (0.137–0.146) | 0.145 (0.139–0.154) | +2% (noise) |
| overhead | added_p99_ms | 1.55 (1.52–1.62) | 1.46 (1.38–1.66) | -6% |
| burst | plain_wall_ms | 757 (736–769) | 751 (743–844) | -1% (noise) |
| burst | plain_call_p50_ms | 0.632 (0.621–0.643) | 0.636 (0.627–0.674) | +1% (noise) |
| burst | plain_call_p99_ms | 2.56 (2.42–2.71) | 2.5 (2.38–3.2) | -2% (noise) |
| burst | wall_ms | 2,162 (2,121–2,219) | 2,237 (2,226–2,409) | +3% |
| burst | call_p50_ms | 2.02 (1.9–2.07) | 1.99 (1.95–2.18) | -2% (noise) |
| burst | call_p99_ms | 4.75 (4.61–5.1) | 4.64 (4.36–5.18) | -2% (noise) |
| burst | added_call_p50_ms | 1.38 (1.27–1.44) | 1.35 (1.32–1.5) | -2% (noise) |
| burst | added_call_p99_ms | 2.29 (1.9–2.67) | 2.02 (1.98–2.18) | -12% (noise) |
| burst | close_ms | 2.5 (2.27–2.64) | 2.51 (2.45–3.22) | +0% (noise) |
| burst | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | delivered | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | plain_wall_ms | 790 (774–796) | 779 (767–798) | -1% (noise) |
| outage_hang | plain_call_p50_ms | 0.645 (0.636–0.666) | 0.652 (0.644–0.688) | +1% (noise) |
| outage_hang | plain_call_p99_ms | 2.37 (2.25–2.48) | 2.32 (2.17–2.43) | -2% (noise) |
| outage_hang | wall_ms | 1,780 (1,768–1,804) | 1,874 (1,835–1,887) | +5% |
| outage_hang | call_p50_ms | 1.59 (1.57–1.6) | 1.67 (1.65–1.68) | +5% |
| outage_hang | call_p99_ms | 3.52 (3.43–3.58) | 3.56 (3.52–3.67) | +1% (noise) |
| outage_hang | added_call_p50_ms | 0.943 (0.925–0.958) | 1 (0.994–1.03) | +6% |
| outage_hang | added_call_p99_ms | 1.15 (1.03–1.27) | 1.22 (1.09–1.5) | +5% (noise) |
| outage_hang | close_ms | 3,001 (3,000–3,002) | 3,001 (3,000–3,002) | -0% (noise) |
| outage_hang | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | plain_wall_ms | 761 (757–784) | 765 (751–787) | +1% (noise) |
| outage_down | plain_call_p50_ms | 0.628 (0.623–0.638) | 0.626 (0.622–0.648) | -0% (noise) |
| outage_down | plain_call_p99_ms | 2.39 (2.34–2.45) | 2.24 (2.18–2.27) | -6% |
| outage_down | wall_ms | 1,801 (1,771–1,822) | 1,887 (1,853–1,905) | +5% |
| outage_down | call_p50_ms | 1.59 (1.57–1.61) | 1.68 (1.66–1.7) | +5% |
| outage_down | call_p99_ms | 3.64 (3.5–3.85) | 3.58 (3.52–3.73) | -2% (noise) |
| outage_down | added_call_p50_ms | 0.964 (0.945–0.987) | 1.04 (1.03–1.08) | +8% |
| outage_down | added_call_p99_ms | 1.19 (1.12–1.46) | 1.34 (1.31–1.55) | +12% (noise) |
| outage_down | close_ms | 703 (703–703) | 703 (702–703) | +0% (noise) |
| outage_down | emitted | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 20,400 (20,400–20,400) | 20,400 (20,400–20,400) | same |
| memory | heap_after_warmup_bytes | 25,581,056 (25,576,592–25,586,416) | 22,622,776 (22,613,136–22,624,504) | -12% |
| memory | heap_at_half_bytes | 26,081,736 (26,058,816–26,086,168) | 23,101,920 (23,095,488–23,114,000) | -11% |
| memory | heap_at_end_bytes | 26,108,080 (26,100,608–26,135,616) | 23,179,696 (23,141,400–23,205,352) | -11% |
| memory | growth_per_call_bytes | 4.18 (1.91–5.39) | 6.7 (4.59–10.6) | +2.52 (noise) |
| memory_outage | heap_after_warmup_bytes | 26,301,008 (26,294,448–26,400,968) | 23,331,312 (23,308,632–23,434,208) | -11% |
| memory_outage | heap_at_half_bytes | 27,538,992 (27,529,504–27,547,584) | 24,578,376 (24,556,104–24,611,296) | -11% |
| memory_outage | heap_at_end_bytes | 27,495,008 (27,483,672–27,514,688) | 24,558,688 (24,539,080–24,564,544) | -11% |
| memory_outage | growth_per_call_bytes | -4.72 (-5.15–-1.48) | -1.97 (-4.85–-1.01) | +2.75 (noise) |
| large_result | plain_p50_ms | 0.0883 (0.0871–0.0891) | 0.0872 (0.086–0.0917) | -1% (noise) |
| large_result | plain_p99_ms | 0.212 (0.192–0.221) | 0.213 (0.207–0.23) | +1% (noise) |
| large_result | baton_p50_ms | 0.676 (0.673–0.683) | 0.684 (0.681–0.694) | +1% |
| large_result | baton_p99_ms | 3.59 (3.44–3.72) | 3.81 (3.52–3.87) | +6% |
| large_result | added_p50_ms | 0.588 (0.585–0.594) | 0.598 (0.594–0.602) | +2% |
| large_result | added_p99_ms | 3.4 (3.23–3.51) | 3.6 (3.31–3.64) | +6% |
| large_result | heap_growth_bytes | 746,144 (679,256–755,288) | 709,696 (677,288–752,984) | -5% (noise) |
| large_result | emitted | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | delivered | 2,200 (2,200–2,200) | 2,200 (2,200–2,200) | same |
| large_result | lost | 0 (0–0) | 0 (0–0) | same |
| process | max_rss_bytes | 217,853,952 (217,022,464–219,119,616) | 203,268,096 (202,289,152–208,494,592) | -7% |
