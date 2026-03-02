---
description: Maker-checker quality gate for scientific outputs
agent: medsci
---

Evaluate the prior result as a checker and return:
1) Pass/Fail against explicit criteria
2) Missing evidence, unsupported claims, or overstatements
3) Exact revisions needed to pass
4) Final corrected answer if fixes are straightforward

Criteria:
- Methodology is explicit
- Claims are grounded in retrieved data
- Limitations and confidence are stated
- No unsupported medical certainty

Context:
$ARGUMENTS
