# R1 extension boundaries

R1 records per-map, per-target, per-frame outcomes locally and sends schema-v2 telemetry only when the map endpoint explicitly advertises support. The sandbox Clear portal form action remains page-wide: it clears visible fillable controls in every reachable frame, including manual entries. R1 no longer infers a selector list from repeated labels. R3 must either bind a clear action to the exact attempted target and frame or keep the explicit full-form sandbox action with a clear warning; R1 does not invoke clearing after a fill.

Frame routing also remains deliberately conservative while maps have no trained frame affinity. Any inaccessible frame makes a map uncertain, even when another accessible frame has one unique match. R4 should add trained frame affinity so unrelated ad or captcha frames do not disable otherwise safe fills.
