// new-project.component.ts

import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { save } from '@tauri-apps/plugin-dialog';

import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { FloatLabelModule } from 'primeng/floatlabel';
import { FieldsetModule } from 'primeng/fieldset';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { DividerModule } from 'primeng/divider';
import { ProgressBarModule } from 'primeng/progressbar';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { LabelledSwitchComponent } from '../../../shared/generics/labelled-switch/labelled-switch.component';
import { FolderDropZoneComponent } from '../folder-drop-zone/folder-drop-zone.component';
import { ClassificationConfigurationComponent } from '../project-configuration/classification-configuration/classification-configuration.component';
import { PixelsConfigurationComponent } from '../project-configuration/pixels-configuration/pixels-configuration.component';

import { ProjectService } from '../../../services/project/project.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { UserService } from '../../../services/users/user.service';

/** Remembers the name last typed, so it is asked once per machine. */
const OWNER_NAME_KEY = 'didascalie_user_name';

@Component({
  selector: 'app-new-project',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    InputTextModule,
    FloatLabelModule,
    FieldsetModule,
    ToggleSwitchModule,
    DividerModule,
    ProgressBarModule,
    ToastModule,
    LabelledSwitchComponent,
    FolderDropZoneComponent,
    ClassificationConfigurationComponent,
    PixelsConfigurationComponent,
  ],
  providers: [MessageService],
  templateUrl: './new-project.component.html',
  styleUrl: './new-project.component.scss',
})
export class NewProjectComponent implements OnInit {
  projectService = inject(ProjectService);
  labelService = inject(LabelsService);
  private router = inject(Router);
  private messageService = inject(MessageService);
  private userService = inject(UserService);

  /** Name of the project's first account, its administrator. Optional: left
   *  empty, the account keeps the default name and can be renamed later. */
  ownerName = localStorage.getItem(OWNER_NAME_KEY) ?? '';

  readonly isLoading = signal(false);
  readonly savePath = signal<string | null>(null);

  // Validation surfaces
  readonly nameError = signal(false);
  readonly folderError = signal(false);
  readonly savePathError = signal(false);

  readonly canStart = computed(
    () =>
      !!this.projectService.projectName() &&
      !!this.projectService.inputFolder() &&
      !!this.savePath() &&
      this.projectService.isConfigValid() &&
      !this.isLoading(),
  );

  ngOnInit(): void {
    // If the user lands here mid-state (e.g. from a back nav), clear stale errors.
    this.nameError.set(false);
    this.folderError.set(false);
    this.savePathError.set(false);
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  // ==========================================
  // Bindings
  // ==========================================

  get projectName(): string {
    return this.projectService.projectName();
  }
  set projectName(v: string) {
    this.projectService.setName(v);
    if (v) this.nameError.set(false);
    // Auto-suggest the save path when the user names the project, but only if
    // they haven't picked one yet. Tauri's save() will let them confirm.
  }

  get inputFolder(): string {
    return this.projectService.inputFolder() ?? '';
  }
  set inputFolder(v: string) {
    this.projectService.setInputFolder(v);
    if (v) this.folderError.set(false);
  }

  get inputRegex(): string {
    return this.projectService.inputRegex();
  }
  set inputRegex(v: string) {
    this.projectService.setInputRegex(v);
  }

  get videoFrameStep(): number {
    return this.projectService.videoFrameStep();
  }
  set videoFrameStep(v: number) {
    this.projectService.setVideoFrameStep(v);
  }

  get recursive(): boolean {
    return this.projectService.recursive();
  }
  set recursive(v: boolean) {
    this.projectService.setRecursive(v);
  }

  get foldersAsSequences(): boolean {
    return this.projectService.foldersAsSequences();
  }
  set foldersAsSequences(v: boolean) {
    this.projectService.setFoldersAsSequences(v);
  }

  get imagesEmbedded(): boolean {
    return this.projectService.imagesEmbedded();
  }
  set imagesEmbedded(v: boolean) {
    this.projectService.setImagesEmbedded(v);
  }

  get classificationEnabled(): boolean {
    return this.projectService.isClassification();
  }
  set classificationEnabled(v: boolean) {
    this.projectService.setClassificationEnabled(v);
  }

  get segmentationEnabled(): boolean {
    return this.projectService.isSegmentation();
  }
  set segmentationEnabled(v: boolean) {
    this.projectService.setSegmentationEnabled(v);
  }

  get instanceSegmentationEnabled(): boolean {
    return this.projectService.isInstanceSegmentation();
  }
  set instanceSegmentationEnabled(v: boolean) {
    this.projectService.setInstanceSegmentationEnabled(v);
  }

  // ==========================================
  // Actions
  // ==========================================

  onFolderChange(path: string): void {
    this.inputFolder = path;
  }

  async chooseSavePath(): Promise<void> {
    const name = this.projectName?.trim() || 'untitled';
    const path = await save({
      defaultPath: `${name}.dida`,
      filters: [{ name: 'Didascalie Project', extensions: ['dida'] }],
    });
    if (path) {
      this.savePath.set(path);
      this.savePathError.set(false);
    }
  }

  async startProject(): Promise<void> {
    this.nameError.set(!this.projectName);
    this.folderError.set(!this.inputFolder);
    this.savePathError.set(!this.savePath());

    if (!this.canStart()) return;

    this.isLoading.set(true);
    try {
      await this.projectService.create(this.savePath()!);
      await this.nameOwner();
      const result = await this.projectService.scanFolder();
      this.messageService.add({
        severity: 'success',
        summary: 'Project created',
        detail: `Imported ${result.framesImported} images in ${result.sequencesCreated} sequences`,
      });
      this.router.navigate(['/gallery']);
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Could not create project',
        detail: String(error),
      });
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Give the project's first account the creator's name.
   *
   * A new project already has that account and is logged in as it; this only
   * renames it. A failure here must not fail the creation that just succeeded,
   * so it is reported and swallowed — the account page can rename it later.
   */
  private async nameOwner(): Promise<void> {
    const name = this.ownerName.trim();
    if (!name) return;
    try {
      if (!(await this.userService.ensureSession())) return;
      const me = this.userService.current()!;
      if (me.name !== name) {
        await this.userService.update(me.id, { type: 'rename', name });
      }
      localStorage.setItem(OWNER_NAME_KEY, name);
    } catch (error) {
      console.error('[new-project] could not name the first account', error);
    }
  }

  /** Show only the filename for the chosen save path; full path on hover. */
  savePathDisplay(): string {
    const p = this.savePath();
    if (!p) return '';
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }
  
}
