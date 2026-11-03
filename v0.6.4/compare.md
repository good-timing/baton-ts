## typescript: 0.6.3 published vs 0.6.4 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. Median (lowest–highest) of 5, 5 runs.

| measure | metric | 0.6.3 published | 0.6.4 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.0665 (0.0647–0.0749) | 0.0673 (0.0663–0.0766) | +1% (noise) |
| overhead | plain_p99_ms | 0.204 (0.191–0.224) | 0.22 (0.208–0.224) | +8% (noise) |
| overhead | baton_p50_ms | 0.534 (0.507–0.545) | 0.166 (0.164–0.189) | -69% |
| overhead | baton_p99_ms | 2.59 (2.3–2.66) | 1.59 (1.49–1.64) | -39% |
| overhead | added_p50_ms | 0.467 (0.441–0.48) | 0.0988 (0.0873–0.122) | -79% |
| overhead | added_p99_ms | 2.39 (2.11–2.47) | 1.38 (1.27–1.42) | -42% |
| burst | wall_ms | 1,439 (1,410–1,457) | 1,402 (1,377–1,417) | -3% |
| burst | call_p50_ms | 1.3 (1.28–1.31) | 1.29 (1.26–1.31) | -1% (noise) |
| burst | call_p99_ms | 3.62 (3.29–3.82) | 3.28 (3.15–3.51) | -9% |
| burst | close_ms | 667 (636–669) | 1.82 (1.68–2.02) | -100% |
| burst | emitted | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | delivered | 1,499 (1,498–1,499) | 20,000 (20,000–20,000) | +1234% |
| burst | lost | 18,501 (18,501–18,502) | 0 (0–0) | -100% |
| outage_hang | wall_ms | 203 (176–205) | 209 (208–214) | +3% |
| outage_hang | call_p50_ms | 0.837 (0.757–0.861) | 0.912 (0.902–0.927) | +9% |
| outage_hang | call_p99_ms | 3.34 (2.32–3.42) | 2.8 (2.54–3) | -16% (noise) |
| outage_hang | close_ms | 3,002 (3,000–3,003) | 3,001 (3,000–3,001) | -0% (noise) |
| outage_hang | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | wall_ms | 177 (175–183) | 224 (220–230) | +27% |
| outage_down | call_p50_ms | 0.759 (0.751–0.765) | 0.899 (0.873–0.913) | +18% |
| outage_down | call_p99_ms | 2.85 (2.5–3.13) | 3.89 (3.69–4.27) | +37% |
| outage_down | close_ms | 3,001 (3,001–3,001) | 1,187 (1,182–1,191) | -60% |
| outage_down | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| memory | heap_after_warmup_bytes | 27,754,488 (27,732,488–28,665,808) | 23,380,656 (22,465,048–23,422,336) | -16% |
| memory | heap_at_half_bytes | 36,407,696 (35,909,456–36,709,656) | 22,377,352 (22,360,248–22,392,888) | -39% |
| memory | heap_at_end_bytes | 45,514,568 (45,442,656–45,541,128) | 22,479,968 (22,461,424–22,504,552) | -51% |
| memory | growth_per_call_bytes | 911 (881–953) | 10.8 (8.41–11.4) | -99% |
| memory_outage | heap_after_warmup_bytes | 28,223,080 (27,965,800–28,297,120) | 22,612,336 (22,601,760–22,636,280) | -20% |
| memory_outage | heap_at_half_bytes | 35,127,592 (35,064,520–35,447,056) | 23,820,672 (23,785,472–23,826,000) | -32% |
| memory_outage | heap_at_end_bytes | 42,291,720 (42,262,112–42,603,280) | 23,774,048 (23,757,752–23,803,664) | -44% |
| memory_outage | growth_per_call_bytes | 716 (715–720) | -2.89 (-4.74–-2.23) | -100% |
| process | max_rss_bytes | 245,805,056 (241,840,128–247,492,608) | 208,142,336 (207,953,920–208,445,440) | -15% |
