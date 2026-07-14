// Mealie API client
// API docs: https://docs.mealie.io/api/redoc/ (endpoints verified against v3.20.1 source)

const MEALIE_URL = process.env.MEALIE_URL || 'http://mealie.mealie.svc.cluster.local:9000';
const MEALIE_API_TOKEN = process.env.MEALIE_API_TOKEN;
const MEALIE_PUBLIC_URL = process.env.MEALIE_PUBLIC_URL || 'https://recipes.lab.mtgibbs.dev';
const MEALIE_GROUP_SLUG = process.env.MEALIE_GROUP_SLUG || 'home';

// Web-UI link for a recipe (v3 routes are group-scoped)
export function recipeUrl(slug: string): string {
  return `${MEALIE_PUBLIC_URL}/g/${MEALIE_GROUP_SLUG}/r/${slug}`;
}

async function mealieFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!MEALIE_API_TOKEN) {
    throw new Error('MEALIE_API_TOKEN environment variable not set');
  }

  const url = `${MEALIE_URL}/api${path}`;
  const headers = {
    Authorization: `Bearer ${MEALIE_API_TOKEN}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Mealie API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }

  return response.json() as Promise<T>;
}

// Types based on Mealie API (summary fields only — full Recipe is much larger)

export interface AppAbout {
  production: boolean;
  version: string;
  demoStatus: boolean;
  allowSignup: boolean;
}

export interface AppStatistics {
  totalRecipes: number;
  totalUsers: number;
  totalCategories: number;
  totalTags: number;
  totalTools: number;
}

export interface RecipeSummary {
  id: string;
  slug: string;
  name: string;
  description?: string;
  totalTime?: string | null;
  recipeServings?: number;
  rating?: number | null;
  orgURL?: string | null;
  dateAdded?: string;
  recipeCategory?: { name: string }[];
  tags?: { name: string }[];
}

export interface PaginatedRecipes {
  page: number;
  total: number;
  totalPages: number;
  items: RecipeSummary[];
}

export interface RecipeIngredient {
  quantity?: number | null;
  unit?: { name: string } | null;
  food?: { name: string } | null;
  note?: string | null;
  display?: string;
}

export interface RecipeInstruction {
  title?: string;
  text: string;
}

export interface Recipe extends RecipeSummary {
  recipeIngredient: RecipeIngredient[];
  recipeInstructions: RecipeInstruction[];
  recipeYield?: string | null;
  prepTime?: string | null;
  performTime?: string | null;
  notes?: { title?: string; text: string }[];
}

export async function getAbout(): Promise<AppAbout> {
  return mealieFetch<AppAbout>('/app/about');
}

export async function getStatistics(): Promise<AppStatistics> {
  return mealieFetch<AppStatistics>('/admin/about/statistics');
}

export async function searchRecipes(search: string | undefined, page: number, perPage: number): Promise<PaginatedRecipes> {
  const params = new URLSearchParams({
    page: String(page),
    perPage: String(perPage),
    orderBy: 'created_at',
    orderDirection: 'desc',
  });
  if (search) {
    params.set('search', search);
  }
  return mealieFetch<PaginatedRecipes>(`/recipes?${params.toString()}`);
}

export async function getRecipe(slug: string): Promise<Recipe> {
  return mealieFetch<Recipe>(`/recipes/${encodeURIComponent(slug)}`);
}

// Returns the slug of the created recipe
export async function importRecipeFromUrl(url: string, includeTags: boolean): Promise<string> {
  return mealieFetch<string>('/recipes/create/url', {
    method: 'POST',
    body: JSON.stringify({ url, includeTags }),
  });
}
