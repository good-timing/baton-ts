#!/usr/bin/env python3
"""Regenerate `test/identityVectors.json` FROM the Python SDK.

Run against a checkout of `baton` (the Python SDK) whose venv has it installed:

    ~/workplace/baton/.venv/bin/python scripts/gen_identity_vectors.py

Why a generated corpus rather than hand-written expectations: a hand-written
value only proves `src/identity.ts` agrees with whoever wrote the test. These
prove it agrees with the OTHER SDK, which is the property that matters — one
person reaching both must be one actor in the Console.

⚠ The method is NEW here. `scrub.ts` parity mirrors Python's test matrix by
hand, case-for-case; nothing there is generated.

⚠ **When Python's `hash_principal_id` changes, regenerate and expect reds.** That is
the mechanism working, not a broken test. In particular the `issuer
WHITESPACE-ONLY` case pins a defect BOTH arms carry deliberately (see
`normalizePrincipal`): whichever arm is fixed first reddens the other and
forces the paired change, which is the only safe way to move a shared digest.
"""

from __future__ import annotations

import json
import pathlib

from baton.identity import hash_principal_id

TENANT = "tenant-parity"
# Non-ASCII bytes in the key too, so a UTF-8 encoding mistake on either arm
# cannot hide behind an all-ASCII secret.
KEY = b"parity-corpus-key-\xf0\x9f\x94\x91"

#: (name, principal, issuer). Names are asserted on in the test, so a trap case
#: cannot be dropped silently.
#:
#: The `scheme` dimension is GONE at 0.8.11 / ts 0.4.1, with the case "scheme is
#: a label, not message bytes". That case hashed one principal under `h2` and
#: expected the same hex under a different prefix, pinning that the tag was not
#: in the HMAC message. There is no tag to vary now, so the property is vacuous
#: rather than unproven — and the `plain ascii` digest below is byte-identical to
#: the hex the tagged corpus carried, which proves the removal moved no digit
#: ACROSS the language boundary.
CASES: list[tuple[str, str, str | None]] = [
    ("plain ascii", "employee-4417", None),
    ("issuer present", "employee-4417", "https://idp.example"),
    ("issuer WHITESPACE-ONLY (paired defect)", "e-1", "   "),
    ("issuer empty string", "e-1", ""),
    ("uppercase folds", "Employee-4417", None),
    ("surrounding whitespace", "  employee-4417\t\n", None),
    ("NFD needs NFC", "José", None),
    ("NFC already", "José", None),
    (
        "BOM-prefixed (JS trim strips U+FEFF, Python strip does NOT)",
        "﻿employee-4417",
        None,
    ),
    ("non-breaking space around", " employee ", None),
    ("turkish dotted I", "İSTANBUL", None),
    ("sharp s", "STRAẞE", None),
    ("emoji principal", "\U0001f600-user", None),
    ("cyrillic", "Петр", None),
    ("issuer needs NFC too", "e-1", "https://idé.example"),
    ("empty after canonicalize", "   ", None),
]


def main() -> None:
    payload = {
        "_note": (
            "GENERATED from baton.identity.hash_principal_id. Never hand-edit; "
            "regenerate with scripts/gen_identity_vectors.py."
        ),
        "key_utf8": KEY.decode(),
        "tenant_id": TENANT,
        "cases": [
            {
                "name": name,
                "principal": principal,
                "issuer": issuer,
                "expected": hash_principal_id(
                    principal, tenant_id=TENANT, key=KEY, issuer=issuer
                ),
            }
            for name, principal, issuer in CASES
        ],
    }
    dest = pathlib.Path(__file__).resolve().parent.parent / "test" / "identityVectors.json"
    dest.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(CASES)} vectors to {dest}")


if __name__ == "__main__":
    main()
