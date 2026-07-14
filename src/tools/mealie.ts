import type { Tool } from './index.js';
import * as mealie from '../clients/mealie.js';
import { validationError, type ToolError } from '../utils/errors.js';

const PRIVATE_IPV4 =
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

// Gate for the import sink: Mealie's server fetches the URL we hand it, so
// refuse anything that could point it at cluster-internal or LAN targets.
export function validateImportUrl(raw: unknown): URL | ToolError {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return validationError('url must be a non-empty string (max 2048 chars)');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return validationError(`url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return validationError(`url must be http(s), got ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.startsWith('[') || // IPv6 literal
    host.includes(':') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.cluster.local') ||
    host.endsWith('.lab.mtgibbs.dev') ||
    PRIVATE_IPV4.test(host)
  ) {
    return validationError(`url host '${host}' is internal/private — recipe imports must target public sites`);
  }
  return url;
}

// Active-run guard: one in-flight import per normalized URL, so overlapping
// calls can't race Mealie into duplicate recipes.
const activeImports = new Set<string>();

export function beginImport(key: string): boolean {
  if (activeImports.has(key)) {
    return false;
  }
  activeImports.add(key);
  return true;
}

export function endImport(key: string): void {
  activeImports.delete(key);
}

export function validateSlug(raw: unknown): string | ToolError {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) {
    return validationError('slug must be a non-empty string (max 256 chars)');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(raw)) {
    return validationError(`slug '${raw}' is not a valid Mealie slug`);
  }
  return raw;
}

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
    const slug = validateSlug(params.slug);
    if (typeof slug !== 'string') {
      return slug;
    }

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
    const url = validateImportUrl(params.url);
    if (!(url instanceof URL)) {
      return url;
    }
    const includeTags = params.includeTags !== false;

    const importKey = url.toString();
    if (!beginImport(importKey)) {
      return {
        error: true,
        code: 'IMPORT_IN_PROGRESS',
        message: `An import for ${importKey} is already running — wait for it to finish instead of retrying.`,
      };
    }
    try {
      const slug = await mealie.importRecipeFromUrl(importKey, includeTags);
      return {
        imported: true,
        slug,
        url: mealie.recipeUrl(slug),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Mealie error';
      return { error: true, code: 'MEALIE_ERROR', message };
    } finally {
      endImport(importKey);
    }
  },
};

export const mealieTools: Tool[] = [getMealieStatus, searchMealieRecipes, getMealieRecipe, importMealieRecipeUrl];
