"""Regenerate test/integrations/mcp/llmTextVectors.json from the Python SDK.

Run from a baton checkout at the release being matched:
  .venv/bin/python ../baton-ts/scripts/gen-llm-text-vectors.py > ../baton-ts/test/integrations/mcp/llmTextVectors.json
"""
import json, subprocess, sys
from baton.integrations import _llm_text as t

head = subprocess.run(
    ["git", "describe", "--tags", "--always"], capture_output=True, text=True, check=True
).stdout.strip()
cases = []
for vendor, tool in [("Acme", "acme_annotate"), ("toybox-pantry", "toybox-pantry_annotate")]:
    cases.append({
        "vendor_display_name": vendor,
        "annotation_tool_name": tool,
        "instructions": t.build_server_instructions(vendor_display_name=vendor, annotation_tool_name=tool),
        "description": t.build_annotation_tool_description(vendor_display_name=vendor),
    })
out = {
    "generated_by": f"baton {head}: baton.integrations._llm_text build_server_instructions, build_annotation_tool_description and build_user_goal_param_description, default proactive_mode (report_mode='on')",
    "cases": cases,
    "param_descriptions": {m: {"user_goal": t.build_user_goal_param_description(intent_param_mode=m)} for m in ("required", "optional")},
    "required_param_names": list(t.required_param_names(intent_param_mode="required")),
    "subagent_clause": t._INSTRUCTIONS_SUBAGENT_CLAUSE,
    "intent_instructions": t.INTENT_INSTRUCTIONS,
}
json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
sys.stdout.write("\n")
