import type { StaryuConfig } from "../core/config.ts";
import { UserError } from "../core/errors.ts";
import { formatNumber } from "../ui/table.ts";
import { ensure, p } from "../ui/prompts.ts";

export const COMMON_LANGUAGES = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "C++",
  "C#",
  "Ruby",
  "PHP",
  "Swift",
  "Kotlin",
  "Elixir",
  "Zig",
  "Lua",
  "Shell",
];

export interface LanguageSuggestion {
  name: string;
  count?: number;
}

export function buildLanguageOptions(
  selected: string[],
  suggestions: LanguageSuggestion[] = [],
): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];

  const push = (language: string, label = language) => {
    const key = language.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({ value: language, label });
  };

  for (const suggestion of suggestions) {
    push(
      suggestion.name,
      suggestion.count === undefined ? suggestion.name : `${suggestion.name} (${suggestion.count})`,
    );
  }
  for (const language of selected) {
    push(language);
  }
  for (const language of COMMON_LANGUAGES) {
    push(language);
  }

  return options;
}

export function nearestActivity(value: number): number {
  const options = [90, 180, 365];
  return options.reduce((best, option) =>
    Math.abs(option - value) < Math.abs(best - value) ? option : best,
  );
}

export function describePreferences(config: StaryuConfig): string {
  const languages = config.preferences.languages.length > 0
    ? config.preferences.languages.join(", ")
    : "all languages";
  const { min, max } = config.preferences.stars;
  return `${languages} · ${formatNumber(min)}–${formatNumber(max)} stars · pushed in the last ${config.preferences.activity.pushedWithinDays} days`;
}

export interface EditablePreferences {
  languages: string[];
  stars: {
    min: number;
    max: number;
  };
  pushedWithinDays: number;
}

export function applyPreferences(
  config: StaryuConfig,
  preferences: EditablePreferences,
): StaryuConfig {
  return {
    ...config,
    preferences: {
      ...config.preferences,
      languages: [...preferences.languages],
      stars: { ...preferences.stars },
      activity: {
        ...config.preferences.activity,
        pushedWithinDays: preferences.pushedWithinDays,
      },
    },
  };
}

export async function promptPreferences(config: StaryuConfig): Promise<EditablePreferences> {
  const languages = ensure(
    await p.multiselect<string>({
      message: "Which languages should staryu explore? (space to select, none for all)",
      options: buildLanguageOptions(config.preferences.languages),
      initialValues: config.preferences.languages,
      required: false,
    }),
  );

  const starMin = ensure(
    await p.text({
      message: "Minimum stars",
      initialValue: String(config.preferences.stars.min),
      validate: (value) => (Number.isFinite(Number(value ?? "")) ? undefined : "Enter a number"),
    }),
  );
  const starMax = ensure(
    await p.text({
      message: "Maximum stars",
      initialValue: String(config.preferences.stars.max),
      validate: (value) => (Number.isFinite(Number(value ?? "")) ? undefined : "Enter a number"),
    }),
  );

  const min = Number(starMin);
  const max = Number(starMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new UserError("Maximum stars must be greater than or equal to minimum stars.");
  }

  const pushedWithinDays = ensure(
    await p.select<number>({
      message: "How recently must a repository have been pushed to?",
      options: [
        { value: 90, label: "Last 90 days" },
        { value: 180, label: "Last 180 days" },
        { value: 365, label: "Last year" },
      ],
      initialValue: nearestActivity(config.preferences.activity.pushedWithinDays),
    }),
  );

  return {
    languages: (languages as string[]).filter(Boolean),
    stars: { min: Math.round(min), max: Math.round(max) },
    pushedWithinDays,
  };
}
