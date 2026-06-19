import { Injectable, inject, signal } from '@angular/core';
import { PrimeNG } from 'primeng/config';
import Aura from '@primeng/themes/aura';
import Lara from '@primeng/themes/lara';
import Nora from '@primeng/themes/nora';
import Material from '@primeng/themes/material';

export type ThemePresetKey = 'aura' | 'lara' | 'nora' | 'material';

interface PresetOption {
  label: string;
  value: ThemePresetKey;
  // PrimeNG preset objects are untyped.
  preset: unknown;
}

const STORAGE_PRESET = 'labelmed.theme.preset';
const STORAGE_DARK = 'labelmed.theme.dark';
const DARK_CLASS = 'darkTheme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly primeng = inject(PrimeNG);

  readonly presets: PresetOption[] = [
    { label: 'Aura', value: 'aura', preset: Aura },
    { label: 'Lara', value: 'lara', preset: Lara },
    { label: 'Nora', value: 'nora', preset: Nora },
    { label: 'Material', value: 'material', preset: Material },
  ];

  readonly presetKey = signal<ThemePresetKey>(this.loadPreset());
  readonly darkMode = signal<boolean>(this.loadDark());

  /** Apply the persisted selection. Call once at startup. */
  init(): void {
    this.applyDarkClass(this.darkMode());
    this.applyPreset(this.presetKey());
  }

  setPreset(key: ThemePresetKey): void {
    this.presetKey.set(key);
    localStorage.setItem(STORAGE_PRESET, key);
    this.applyPreset(key);
  }

  setDarkMode(dark: boolean): void {
    this.darkMode.set(dark);
    localStorage.setItem(STORAGE_DARK, dark ? '1' : '0');
    this.applyDarkClass(dark);
  }

  toggleDarkMode(): void {
    this.setDarkMode(!this.darkMode());
  }

  private applyPreset(key: ThemePresetKey): void {
    const preset =
      this.presets.find((p) => p.value === key)?.preset ?? Aura;
    this.primeng.theme.set({
      preset,
      options: {
        darkModeSelector: `.${DARK_CLASS}`,
        cssLayer: {
          name: 'primeng',
          order: 'tailwind-base, primeng, tailwind-utilities',
        },
      },
    });
  }

  private applyDarkClass(dark: boolean): void {
    document.documentElement.classList.toggle(DARK_CLASS, dark);
  }

  private loadPreset(): ThemePresetKey {
    const v = localStorage.getItem(STORAGE_PRESET);
    const valid: ThemePresetKey[] = ['aura', 'lara', 'nora', 'material'];
    return v && valid.includes(v as ThemePresetKey)
      ? (v as ThemePresetKey)
      : 'aura';
  }

  private loadDark(): boolean {
    const v = localStorage.getItem(STORAGE_DARK);
    if (v === null) {
      // First run: follow the OS preference.
      return (
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
      );
    }
    return v === '1';
  }
}
