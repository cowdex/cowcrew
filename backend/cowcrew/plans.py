"""A rough range for what agent usage costs on a Claude subscription.

The Agent SDK reports every run's cost at API prices, even on a Claude plan; Anthropic says that
figure isn't what a subscriber pays. A plan buys a weekly allowance whose API-priced value
depends on the model mix and caching, so any dollar conversion is an estimate. CowCrew shows a
range between two published measurements of a full weekly allowance, per dollar of monthly price:
- low  ≈ $7.75 / $1 (Wokey, Oct 26–Nov 2 2026: Pro ≈ $155/week, Max 20x ≈ $1,549/week)
- high ≈ $12 / $1   (community account comparison: Pro ≈ $240, Max ≈ $1,200, Ultra ≈ $2,300/week)
A larger allowance value means each API dollar costs you less, so "high" gives the low end.
"""

from __future__ import annotations

from pydantic import BaseModel

WEEKS_PER_MONTH = 52 / 12
VALUE_PER_DOLLAR_LOW = 7.75
VALUE_PER_DOLLAR_HIGH = 12.0


class Plan(BaseModel):
    key: str
    name: str
    price_month: float

    @property
    def price_week(self) -> float:
        return self.price_month / WEEKS_PER_MONTH

    def factors(self) -> tuple[float, float]:
        """Real dollars per API-priced dollar: (low, high)."""
        per_week = self.price_week
        return (per_week / (self.price_month * VALUE_PER_DOLLAR_HIGH),
                per_week / (self.price_month * VALUE_PER_DOLLAR_LOW))

    def real_cost(self, api_usd: float) -> tuple[float, float]:
        lo, hi = self.factors()
        return api_usd * lo, api_usd * hi

    def used_pct(self, api_usd: float) -> tuple[float, float]:
        """Share of the weekly allowance, low and high estimate."""
        return (100 * api_usd / (self.price_month * VALUE_PER_DOLLAR_HIGH),
                100 * api_usd / (self.price_month * VALUE_PER_DOLLAR_LOW))


PLANS: dict[str, Plan] = {
    "pro": Plan(key="pro", name="Pro", price_month=20),
    "max": Plan(key="max", name="Max", price_month=100),
    "ultra": Plan(key="ultra", name="Ultra", price_month=200),
}
