"""What agent usage really costs on a Claude subscription.

The Agent SDK reports every run's cost at API prices, even on a Claude plan. A plan doesn't
charge per token: it buys a weekly allowance. Community measurements put that allowance at
roughly $12 of API-priced usage per dollar of monthly price, for every plan (Pro $20 ≈ $240 a
week, Max $100 ≈ $1,200, Ultra $200 ≈ $2,400, which is 10x Pro). So the real cost of a run is
its share of the weekly allowance times what the plan costs per week. These are estimates:
Anthropic doesn't publish the allowance in dollars.
"""

from __future__ import annotations

from pydantic import BaseModel

WEEKS_PER_MONTH = 52 / 12


class Plan(BaseModel):
    key: str
    name: str
    price_month: float
    weekly_value_usd: float  # API-priced usage one weekly allowance covers (estimate)

    @property
    def price_week(self) -> float:
        return self.price_month / WEEKS_PER_MONTH

    def real_cost(self, api_usd: float) -> float:
        """Subscription dollars a run worth `api_usd` at API prices uses up."""
        return api_usd * self.price_week / self.weekly_value_usd

    def used_pct(self, api_usd: float) -> float:
        return 100 * api_usd / self.weekly_value_usd


PLANS: dict[str, Plan] = {
    "pro": Plan(key="pro", name="Pro", price_month=20, weekly_value_usd=240),
    "max": Plan(key="max", name="Max", price_month=100, weekly_value_usd=1200),
    "ultra": Plan(key="ultra", name="Ultra", price_month=200, weekly_value_usd=2400),
}
