/**
 * @fileoverview
 *
 * The SnuggeryArchitectHost is a re-implementation of the WorkspaceNodeModulesArchitectHost
 * that throws different types of errors (like angular does do in the schematic workflow) and
 * supports Tao-style executors
 */

import type {
  Target,
  BuilderInfo,
  createBuilder,
} from '@angular-devkit/architect';
// It would be great if we could have access to these without going through `/src/internal/`.
import {
  ArchitectHost,
  Builder,
  BuilderSymbol,
} from '@angular-devkit/architect/src/internal';
import {isJsonObject, JsonObject, JsonValue} from '@angular-devkit/core';
import type {ProjectDefinition, TargetDefinition} from '@snuggery/core';
import {dirname, join} from 'path';

import type {Context} from '../command/context';
import type {Executor} from '../utils/tao';

import {InvalidBuilderError, InvalidBuilderSpecifiedError} from './errors';

export {Builder};

export function isBuilder(value: object): value is Builder {
  return BuilderSymbol in value && (value as Builder)[BuilderSymbol];
}

export interface SnuggeryBuilderInfo extends BuilderInfo {
  /**
   * Package or builder JSON path the builder was loaded from
   *
   * If this is null, the builder was referenced directly (via `$direct:path/to/builder`).
   */
  packageName: string | null;

  /**
   * Absolute path to the builder implementation
   */
  implementationPath: string;

  /**
   * Key the builder is exported as, default export if `null`
   */
  implementationExport: string | null;

  /**
   * Whether the builder is a Tao executor rather than an Angular devkit builder
   *
   * If this is `true`, it's definitely a Tao executor.
   * If this is `false`, it's definitely an Angular devkit builder.
   * Otherwise, it might be an executor.
   */
  isNx: boolean | null;
}

export interface ResolverFacade {
  /**
   * Load the configuration for builders in the given package
   *
   * @param packageName Name of the builder package to load
   * @param builderSpec Identifier of the builder to use when logging errors
   * @throws If the builder cannot be found, cannot be loaded, is invalid, etc.
   */
  loadBuilders(
    packageName: string,
    builderSpec: string,
  ): [
    path: string,
    builders: Record<string, JsonObject>,
    executors?: Record<string, JsonObject>,
  ];

  /**
   * Resolve a single builder out of a builders configuration file
   *
   * @param packageName Package name (or path to a builders.json) to resolve the builder from
   * @param builderName Name of the builder to resolve
   * @param builderSpec Identifier of the builder to use when logging errors
   * @throws If the builder cannot be found, cannot be loaded, is invalid, etc.
   */
  resolveBuilder(
    packageName: string,
    builderName: string,
    builderSpec: string,
  ): [builderPath: string, builderInfo: JsonValue, isNx: boolean | null];

  /**
   * Resolve a single builder directly from path
   *
   * @param path The path to load the builder from
   * @throws If the builder cannot be found, cannot be loaded, is invalid, etc.
   */
  resolveDirectBuilder(path: string): Promise<[path: string, info: JsonObject]>;
}

export interface WorkspaceFacade {
  /**
   * Directory the workspace is in
   */
  readonly basePath?: string;

  /**
   * Returns the project for the given name
   *
   * @param projectName The name of the project
   * @throws if the given project name is not found or it's invalid
   */
  getProject(projectName: string): ProjectDefinition;

  /**
   * Returns metadata for the project with the given name
   *
   * @param projectName The name of the project
   * @throws if the given project name is not found or it's invalid
   */
  getProjectMetadata(projectName: string): JsonObject;

  /**
   * Returns the given target configuration
   *
   * @param target The target to look up
   * @throws if the given target is not found or it's invalid
   */
  getTarget(target: Target): TargetDefinition;

  /**
   * Returns the options configured for the given target
   *
   * @param target The target to look up
   * @throws if the given target is not found or it's invalid
   */
  getOptionsForTarget(target: Target): JsonObject | null;

  /**
   * Convert the given executor into a builder that can be executed using the angular devkit
   *
   * @param executor The executor to convert
   */
  convertExecutorIntoBuilder(
    executor: Executor,
  ): ReturnType<typeof createBuilder>;
}

/**
 * An architect host supporting angular-style builders and tao-style executors
 */
export class SnuggeryArchitectHost
  implements ArchitectHost<SnuggeryBuilderInfo> {
  constructor(
    private readonly context: Pick<Context, 'startCwd'>,
    private readonly resolver: ResolverFacade,
    private readonly workspace: WorkspaceFacade,
  ) {}

  /** @override */
  async getBuilderNameForTarget(target: Target): Promise<string> {
    return this.workspace.getTarget(target).builder;
  }

  /** @override */
  listBuilders(packageName: string): {name: string; description?: string}[] {
    const [, builderJson, executorsJson] = this.resolver.loadBuilders(
      packageName,
      packageName,
    );

    const names = new Set([
      ...Object.keys(builderJson),
      ...Object.keys(executorsJson || {}),
    ]);

    return Array.from(names, name => {
      const description =
        builderJson[name]?.description ?? executorsJson?.[name]?.description;

      if (typeof description === 'string') {
        return {name, description};
      } else {
        return {name};
      }
    });
  }

  /** @override */
  async resolveBuilder(builderSpec: string): Promise<SnuggeryBuilderInfo> {
    const [packageName, builderName] = builderSpec.split(':', 2) as [
      string,
      string | undefined,
    ];

    if (builderName == null) {
      throw new InvalidBuilderSpecifiedError(
        `Builders must list a collection, use $direct as collection if you want to use a builder directly`,
      );
    }

    let builderPath: string;
    let builderInfo: JsonValue;
    let isNx: boolean | null = null;

    if (packageName === '$direct') {
      [builderPath, builderInfo] = await this.resolver.resolveDirectBuilder(
        builderName,
      );
    } else {
      [builderPath, builderInfo, isNx] = this.resolver.resolveBuilder(
        packageName,
        builderName,
        builderSpec,
      );
    }

    if (
      !isJsonObject(builderInfo) ||
      typeof builderInfo.implementation !== 'string' ||
      (typeof builderInfo.schema !== 'string' &&
        typeof builderInfo.schema !== 'boolean')
    ) {
      throw new InvalidBuilderError(
        packageName !== '$direct'
          ? `Invalid configuration for builder "${builderName}" in package "${packageName}"`
          : `Invalid configuration for builder "${builderName}"`,
      );
    }

    let optionSchema: JsonValue;
    if (typeof builderInfo.schema === 'boolean') {
      optionSchema = builderInfo.schema;
    } else {
      const schemaPath = join(dirname(builderPath), builderInfo.schema);
      try {
        optionSchema = require(schemaPath);
      } catch {
        throw new InvalidBuilderError(
          `Couldn't load schema "${schemaPath}" for builder "${builderName}" in package "${packageName}"`,
        );
      }

      if (!isJsonObject(optionSchema)) {
        throw new InvalidBuilderError(
          `Invalid schema at "${schemaPath}" for builder "${builderName}" in package "${packageName}"`,
        );
      }
    }

    const description =
      typeof builderInfo.description === 'string'
        ? builderInfo.description
        : undefined!;

    let implementationPath = builderInfo.implementation;
    let implementationExport: string | null = null;

    if (implementationPath.includes('#')) {
      const index = implementationPath.indexOf('#');

      implementationExport = implementationPath.slice(index + 1);
      implementationPath = implementationPath.slice(0, index);
    }

    return {
      packageName,
      builderName,
      description,
      optionSchema,
      implementationPath: join(dirname(builderPath), implementationPath),
      implementationExport,
      isNx,
    };
  }

  /** @override */
  async loadBuilder(
    info: SnuggeryBuilderInfo,
  ): Promise<Builder<JsonObject> | null> {
    let implementation;
    try {
      implementation = await import(info.implementationPath).then(
        info.implementationExport != null
          ? module => module[info.implementationExport!]
          : module => module.default ?? module,
      );
    } catch (e) {
      throw new InvalidBuilderError(
        `Failed to load implementation for builder "${
          info.builderName
        }" in package "${info.packageName}": ${(e as Error)?.message ?? e}`,
      );
    }

    if (implementation == null) {
      throw new InvalidBuilderError(
        `Failed to load implementation for builder "${info.builderName}" in package ${info.packageName}`,
      );
    }

    if (
      info.isNx ||
      (info.isNx !== false &&
        typeof info.optionSchema === 'object' &&
        info.optionSchema.cli === 'nx')
    ) {
      return this.workspace.convertExecutorIntoBuilder(implementation);
    }

    if (!isBuilder(implementation)) {
      throw new InvalidBuilderError(
        `Implementation for builder "${info.builderName}" in package "${info.packageName}" is not a builder`,
      );
    }

    return implementation;
  }

  /** @override */
  getCurrentDirectory(): Promise<string> {
    return Promise.resolve(this.context.startCwd);
  }

  /** @override */
  getWorkspaceRoot(): Promise<string> {
    return Promise.resolve(this.workspace.basePath ?? this.context.startCwd);
  }

  /** @override */
  async getOptionsForTarget(target: Target): Promise<JsonObject | null> {
    return this.workspace.getOptionsForTarget(target);
  }

  /** @override */
  async getProjectMetadata(
    projectNameOrTarget: string | Target,
  ): Promise<JsonObject> {
    return this.workspace.getProjectMetadata(
      typeof projectNameOrTarget === 'string'
        ? projectNameOrTarget
        : projectNameOrTarget.project,
    );
  }
}
