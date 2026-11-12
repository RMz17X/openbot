/**
 * Lightweight English-only catalog loader for standalone WebUI.
 * Eliminates 14 foreign language catalogs (ar, de, es, fr, he, it, ja, ko, nl, pl, pt, ru, tr, zh)
 * saving ~6MB of parsed JSON/JS and 42 separate asset chunks.
 */
import { messages as enFormat } from "../../../../packages/i18n/src/messages/en/format";
import { en } from "../../../../packages/i18n/src/messages/en/index";
import { source as enSource } from "../../../../packages/i18n/src/messages/en/source";

const enCatalogs = { app: en, source: enSource, format: enFormat };

export const appTranslation = (_locale: string) => enCatalogs.app;
export const sourceTranslation = (_locale: string) => enCatalogs.source;
export const formatTranslation = (_locale: string) => enCatalogs.format;
export const localeLoaded = (_locale: string) => true;
export const loadLocale = (_locale: string) => Promise.resolve();
