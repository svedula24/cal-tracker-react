"""Response models for /api/v1/foods."""

from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel, ConfigDict

from app.models.foods import Food, FoodPortion


class PortionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    description: str
    gram_weight: float


class FoodSearchItem(BaseModel):
    """One search result: the foods row as it is stored, and the food's portions, smallest first."""

    fdc_id: int
    description: str
    data_type: str
    brand_name: str | None
    calories_per_100g: float
    protein_per_100g: float
    carbs_per_100g: float
    fat_per_100g: float
    fiber_per_100g: float | None
    sugar_per_100g: float | None
    sodium_mg_per_100g: float | None
    portions: list[PortionOut]


class FoodSearchResponse(BaseModel):
    foods: list[FoodSearchItem]
    limit: int
    offset: int


class NutrientsPer100g(BaseModel):
    """Null means USDA does not report the nutrient for this food, not zero."""

    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float | None
    sugar_g: float | None
    sodium_mg: float | None


class FoodDetail(BaseModel):
    fdc_id: int
    description: str
    data_type: str
    brand_name: str | None
    nutrients_per_100g: NutrientsPer100g
    portions: list[PortionOut]

    @classmethod
    def of(cls, food: Food, portions: Iterable[FoodPortion]) -> FoodDetail:
        """A foods row (flat nutrient columns) and its portions, as the nested response."""
        return cls(
            fdc_id=food.fdc_id,
            description=food.description,
            data_type=food.data_type,
            brand_name=food.brand_name,
            nutrients_per_100g=NutrientsPer100g(
                calories=food.calories_per_100g,
                protein_g=food.protein_per_100g,
                carbs_g=food.carbs_per_100g,
                fat_g=food.fat_per_100g,
                fiber_g=food.fiber_per_100g,
                sugar_g=food.sugar_per_100g,
                sodium_mg=food.sodium_mg_per_100g,
            ),
            portions=[PortionOut.model_validate(p) for p in portions],
        )
