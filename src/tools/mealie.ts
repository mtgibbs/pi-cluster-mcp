import type { Tool } from './index.js';
import * as mealie from '../clients/mealie.js';

interface RecipeSummaryOut {
  slug: string;
  name: string;
  description?: string;
  totalTime?: string;
  servings?: number;
  rating?: number;
  sourceUrl?: string;
  dateAdded?: string;
  categories?: string[];
  tags?: string[];
}

function summarizeRecipe(r: mealie.RecipeSummary): RecipeSummaryOut {
  return {
    slug: r.slug,
    name: r.name,
    description: r.description || undefined,
    totalTime: r.totalTime || undefined,
    servings: r.recipeServings || undefined,
    rating: r.rating ?? undefined,
    sourceUrl: r.orgURL || undefined,
    dateAdded: r.dateAdded,
    categories: r.recipeCategory?.map((c) => c.name),
    tags: r.tags?.map((t) => t.name),
  };
}

const getMealieStatus: Tool = {
  name: 'get_mealie_status',
  description:
    'Get Mealie recipe manager status: version, signup state, and library statistics (recipe/user/category/tag counts).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const about = await mealie.getAbout();
      let statistics: mealie.AppStatistics | { error: string };
      try {
        statistics = await mealie.getStatistics();
      } catch (error) {
        statistics = { error: error instanceof Error ? error.message : 'statistics unavailable' };
      }
      return {
        version: about.version,
        production: about.production,
        allowSignup: about.allowSignup,
        statistics,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Mealie error';
      return { error: true, code: 'MEALIE_ERROR', message };
    }
  },
};

const searchMealieRecipes: Tool = {
  name: 'search_mealie_recipes',
  description:
    'Search recipes in Mealie by text (name, ingredients, description). Omit search to list the most recently added recipes.',
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Search text (optional — omit to list recent recipes)' },
      page: { type: 'number', description: 'Page number (default: 1)', default: 1 },
      perPage: { type: 'number', description: 'Results per page (default: 10, max: 50)', default: 10 },
    },
  },
  handler: async (params) => {
    const search = params.search as string | undefined;
    const page = Math.max((params.page as number) || 1, 1);
    const perPage = Math.min(Math.max((params.perPage as number) || 10, 1), 50);

    try {
      const results = await mealie.searchRecipes(search, page, perPage);
      return {
        total: results.total,
        page: results.page,
        totalPages: results.totalPages,
        recipes: results.items.map(summarizeRecipe),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Mealie error';
      return { error: true, code: 'MEALIE_ERROR', message };
    }
  },
};

const getMealieRecipe: Tool = {
  name: 'get_mealie_recipe',
  description:
    'Get a full recipe from Mealie by slug, including ingredients, instructions, times, and notes.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'Recipe slug (from search_mealie_recipes or an import result)' },
    },
    required: ['slug'],
  },
  handler: async (params) => {
    const slug = params.slug as string;

    try {
      const recipe = await mealie.getRecipe(slug);
      return {
        ...summarizeRecipe(recipe),
        yield: recipe.recipeYield || undefined,
        prepTime: recipe.prepTime || undefined,
        cookTime: recipe.performTime || undefined,
        ingredients: recipe.recipeIngredient.map(
          (i) => i.display || [i.quantity, i.unit?.name, i.food?.name, i.note].filter(Boolean).join(' ')
        ),
        instructions: recipe.recipeInstructions.map((s, idx) => `${idx + 1}. ${s.title ? `${s.title}: ` : ''}${s.text}`),
        notes: recipe.notes?.map((n) => (n.title ? `${n.title}: ${n.text}` : n.text)),
        url: mealie.recipeUrl(recipe.slug),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Mealie error';
      return { error: true, code: 'MEALIE_ERROR', message };
    }
  },
};

const importMealieRecipeUrl: Tool = {
  name: 'import_mealie_recipe_url',
  description:
    'Import a recipe into Mealie from a URL (the recipe-scrapers/schema.org path — no AI required). Returns the created recipe slug. Fails cleanly on sites without structured recipe data.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Recipe page URL to import' },
      includeTags: {
        type: 'boolean',
        description: 'Import the site’s keywords as Mealie tags (default: true)',
        default: true,
      },
    },
    required: ['url'],
  },
  handler: async (params) => {
    const url = params.url as string;
    const includeTags = params.includeTags !== false;

    try {
      const slug = await mealie.importRecipeFromUrl(url, includeTags);
      return {
        imported: true,
        slug,
        url: mealie.recipeUrl(slug),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Mealie error';
      return { error: true, code: 'MEALIE_ERROR', message };
    }
  },
};

export const mealieTools: Tool[] = [getMealieStatus, searchMealieRecipes, getMealieRecipe, importMealieRecipeUrl];
