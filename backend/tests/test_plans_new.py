from cowcrew.plans import PLANS


def test_cost_is_a_range_from_both_measurements() -> None:
    plan = PLANS["max"]
    lo, hi = plan.real_cost(51.17)
    assert lo < hi
    assert round(lo, 2) == 0.98  # at ~$12 of API usage per $1
    assert round(hi, 2) == 1.52  # at ~$7.75 per $1
    plo, phi = plan.used_pct(51.17)
    assert round(plo, 1) == 4.3 and round(phi, 1) == 6.6
