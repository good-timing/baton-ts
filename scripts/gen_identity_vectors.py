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

from baton.identity import HASH_SCHEME, VENDOR_HASH_SCHEME, hash_principal_id

TENANT = "tenant-parity"
# Non-ASCII bytes in the key too, so a UTF-8 encoding mistake on either arm
# cannot hide behind an all-ASCII secret.
KEY = b"parity-corpus-key-\xf0\x9f\x94\x91"

#: (name, principal, issuer, scheme). Names are asserted on in the test, so a
#: trap case cannot be dropped silently.
CASES: list[tuple[str, str, str | None, str]] = [
    ("plain ascii", "employee-4417", None, HASH_SCHEME),
    ("vendor scheme", "employee-4417", None, VENDOR_HASH_SCHEME),
    ("issuer present", "employee-4417", "https://idp.example", HASH_SCHEME),
    ("issuer WHITESPACE-ONLY (paired defect)", "e-1", "   ", HASH_SCHEME),
    ("issuer empty string", "e-1", "", HASH_SCHEME),
    ("uppercase folds", "Employee-4417", None, HASH_SCHEME),
    ("surrounding whitespace", "  employee-4417\t\n", None, HASH_SCHEME),
    ("NFD needs NFC", "José", None, HASH_SCHEME),
    ("NFC already", "José", None, HASH_SCHEME),
    (
        "BOM-prefixed (JS trim strips U+FEFF, Python strip does NOT)",
        "﻿employee-4417",
        None,
        HASH_SCHEME,
    ),
    ("non-breaking space around", " employee ", None, HASH_SCHEME),
    ("turkish dotted I", "İSTANBUL", None, HASH_SCHEME),
    ("sharp s", "STRAẞE", None, HASH_SCHEME),
    ("emoji principal", "\U0001f600-user", None, HASH_SCHEME),
    ("cyrillic", "Петр", None, HASH_SCHEME),
    ("issuer needs NFC too", "e-1", "https://idé.example", HASH_SCHEME),
    ("empty after canonicalize", "   ", None, HASH_SCHEME),
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
                "scheme": scheme,
                "expected": hash_principal_id(
                    principal, tenant_id=TENANT, key=KEY, issuer=issuer, scheme=scheme
                ),
            }
            for name, principal, issuer, scheme in CASES
        ],
    }
    dest = pathlib.Path(__file__).resolve().parent.parent / "test" / "identityVectors.json"
    dest.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(CASES)} vectors to {dest}")


if __name__ == "__main__":
    main()
