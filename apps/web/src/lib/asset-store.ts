import type { SampleAsset } from "./samples";

// In-memory asset library for the UI prototype. Unsaved generations/imports stay out of this list.
let savedAssets: SampleAsset[] = [];

export function getSavedAssets() {
  return savedAssets;
}

export function saveAssetToLibrary(asset: SampleAsset) {
  if (savedAssets.some((item) => item.id === asset.id)) return savedAssets;
  savedAssets = [asset, ...savedAssets];
  return savedAssets;
}
