## typescript: 0.6.5 published vs 0.6.6 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. Median (lowest–highest) of 5, 5 runs.

| measure | metric | 0.6.5 published | 0.6.6 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0411 (0.0396–0.0507) | 0.0385 (0.0365–0.0492) | -6% |
| overhead | plain_p99_ms | 0.166 (0.15–0.247) | 0.168 (0.16–0.189) | +1% (noise) |
| overhead | baton_p50_ms | 0.0918 (0.091–0.0941) | 0.0956 (0.094–0.101) | +4% |
| overhead | baton_p99_ms | 1.28 (1.2–1.39) | 1.22 (1.13–1.26) | -5% (noise) |
| overhead | added_p50_ms | 0.0499 (0.0434–0.0535) | 0.0555 (0.0454–0.0612) | +11% |
| overhead | added_p99_ms | 1.05 (1.03–1.23) | 1.06 (0.94–1.09) | +1% (noise) |
| burst | wall_ms | 927 (922–989) | 937 (927–950) | +1% (noise) |
| burst | call_p50_ms | 0.793 (0.75–0.869) | 0.81 (0.699–0.942) | +2% (noise) |
| burst | call_p99_ms | 2.66 (2.55–2.77) | 2.45 (2.26–2.51) | -8% |
| burst | close_ms | 1.6 (1.47–1.82) | 1.43 (1.35–1.47) | -11% |
| burst | emitted | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | delivered | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | wall_ms | 124 (116–130) | 122 (120–129) | -2% (noise) |
| outage_hang | call_p50_ms | 0.512 (0.497–0.519) | 0.52 (0.508–0.547) | +2% |
| outage_hang | call_p99_ms | 1.97 (1.74–2.11) | 1.83 (1.79–1.89) | -7% (noise) |
| outage_hang | close_ms | 3,001 (3,001–3,002) | 3,001 (3,000–3,002) | -0% (noise) |
| outage_hang | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | wall_ms | 118 (116–123) | 144 (138–146) | +22% |
| outage_down | call_p50_ms | 0.495 (0.487–0.5) | 0.531 (0.522–0.544) | +7% |
| outage_down | call_p99_ms | 1.74 (1.7–1.88) | 3.4 (3.01–3.59) | +95% |
| outage_down | close_ms | 1,289 (1,283–1,290) | 1,262 (1,261–1,274) | -2% |
| outage_down | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| memory | heap_after_warmup_bytes | 26,657,296 (26,649,024–26,681,416) | 23,427,928 (22,503,704–23,446,248) | -12% |
| memory | heap_at_half_bytes | 26,979,824 (26,967,552–27,108,544) | 22,438,768 (22,386,480–22,445,336) | -17% |
| memory | heap_at_end_bytes | 26,134,656 (26,119,472–27,049,312) | 22,548,656 (22,538,816–22,557,728) | -14% |
| memory | growth_per_call_bytes | -84 (-84.8–-5.42) | 10.8 (10.3–17.1) | +113% |
| memory_outage | heap_after_warmup_bytes | 26,404,960 (26,318,760–27,342,664) | 22,677,592 (22,672,792–22,792,016) | -14% |
| memory_outage | heap_at_half_bytes | 27,055,288 (27,039,280–27,526,784) | 23,867,880 (23,864,632–23,886,488) | -12% |
| memory_outage | heap_at_end_bytes | 27,027,608 (27,012,616–27,035,160) | 23,855,888 (23,843,360–23,861,240) | -12% |
| memory_outage | growth_per_call_bytes | -2.67 (-50.8–-1.14) | -2.13 (-2.61–-1.2) | +20% (noise) |
| process | max_rss_bytes | 215,982,080 (215,490,560–218,079,232) | 209,858,560 (203,485,184–212,938,752) | -3% |
