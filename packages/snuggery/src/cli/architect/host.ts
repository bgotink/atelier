import type {Target, BuilderInfo} from '@angular-devkit/architect';
import {
  ArchitectHost,
  Builder,
  BuilderSymbol,
} from '@angular-devkit/architect/src/internal';
import {isJsonObject, JsonObject, JsonValue} from '@angular-devkit/core';
import type {ErrorWithMeta} from 'clipanion';
import {createRequire} from 'module';
import {basename, dirname, join} from 'path';

import type {CliWorkspace, Context} from '../command/context';
import {makeExecutorIntoBuilder} from '../utils/tao';

const {hasOwnProperty} = Object.prototype;

export class UnknownBuilderError extends Error implements ErrorWithMeta {
  public clipanion = {type: 'none'} as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnknownBuilderError';
  }
}

export class UnknownConfigurationError extends Error implements ErrorWithMeta {
  public clipanion = {type: 'none'} as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnknownConfigurationError';
  }
}

export class InvalidBuilderSpecifiedError
  extends Error
  implements ErrorWithMeta {
  public clipanion = {type: 'none'} as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidBuilderSpecifiedError';
  }
}

export class InvalidBuilderError extends Error implements ErrorWithMeta {
  public clipanion = {type: 'none'} as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidBuilderError';
  }
}

export class UnknownTargetError extends Error implements ErrorWithMeta {
  public clipanion = {type: 'none'} as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnknownTargetError';
  }
}

export interface SnuggeryBuilderInfo extends BuilderInfo {
  packageName: string | null;
  implementationPath: string;
  implementationExport: string | null;
  isNx: boolean | null;
}

function isBuilder(value: object): value is Builder {
  return (
    BuilderSymbol in value && (value as {[BuilderSymbol]: true})[BuilderSymbol]
  );
}

export class SnuggeryArchitectHost
  implements ArchitectHost<SnuggeryBuilderInfo> {
  constructor(
    private readonly context: Pick<Context, 'startCwd'>,
    private readonly workspace: CliWorkspace | null,
  ) {}

  private loadBuilderJson(
    packageName: string,
    builderSpec: string,
  ): [
    path: string,
    builders: Record<string, JsonObject>,
    executors?: Record<string, JsonObject>,
  ] {
    for (const basePath of new Set(
      this.workspace != null
        ? [this.context.startCwd, this.workspace.basePath]
        : [this.context.startCwd],
    )) {
      const require = createRequire(join(basePath, '<synthetic>'));

      let startJsonPath: string;
      try {
        startJsonPath = require.resolve(join(packageName, 'package.json'));
      } catch {
        try {
          startJsonPath = require.resolve(packageName);
        } catch {
          continue;
        }
      }

      let buildersJsonPath = startJsonPath;
      let buildersJson: JsonObject;

      try {
        buildersJson = require(buildersJsonPath);
      } catch {
        throw new InvalidBuilderError(
          `Failed to load builder configuration file "${buildersJsonPath}"`,
        );
      }

      while (typeof buildersJson.builders === 'string') {
        buildersJsonPath = join(
          dirname(buildersJsonPath),
          buildersJson.builders,
        );

        try {
          buildersJson = require(buildersJsonPath);
        } catch {
          throw new InvalidBuilderError(
            `Failed to load builder configuration file "${buildersJsonPath}"`,
          );
        }
      }

      if (buildersJson.builders == null) {
        throw new InvalidBuilderError(
          `No builder configuration found in "${packageName}" for builder "${builderSpec}"`,
        );
      }

      if (!isJsonObject(buildersJson.builders)) {
        throw new InvalidBuilderError(
          `Builder configuration file "${buildersJsonPath}" for "${builderSpec}" doesn't match the schema`,
        );
      }

      let executors: Record<string, JsonObject> | undefined;
      if (isJsonObject(buildersJson.executors!)) {
        executors = buildersJson.executors as Record<string, JsonObject>;
      }

      return [
        buildersJsonPath,
        buildersJson.builders as Record<string, JsonObject>,
        executors,
      ];
    }

    throw new UnknownBuilderError(
      `Couldn't find builder configuration in "${packageName}" for builder "${builderSpec}"`,
    );
  }

  private getProject(projectName: string) {
    const project = this.workspace?.projects.get(projectName);

    if (project == null) {
      throw new UnknownTargetError(`Unknown project: "${projectName}"`);
    }

    return project;
  }

  private getTarget(target: Target) {
    const projectTarget = this.getProject(target.project).targets.get(
      target.target,
    );

    if (projectTarget == null) {
      throw new UnknownTargetError(
        `No target named "${target.target}" found in project "${target.project}"`,
      );
    }

    return projectTarget;
  }

  async getBuilderNameForTarget(target: Target): Promise<string> {
    return this.getTarget(target).builder;
  }

  private async resolveBuilderFromPath(
    path: string,
  ): Promise<[path: string, info: JsonObject]> {
    for (const basePath of new Set(
      this.workspace != null
        ? [this.context.startCwd, this.workspace.basePath]
        : [this.context.startCwd],
    )) {
      const require = createRequire(join(basePath, '<synthetic>'));

      let resolvedPath;
      try {
        resolvedPath = require.resolve(path);
      } catch {
        continue;
      }

      let schemaOrBuilder: JsonObject | Builder;
      try {
        schemaOrBuilder = await import(resolvedPath).then(
          module => module.default ?? module,
        );
      } catch {
        throw new InvalidBuilderError(
          `Failed to load builder file "${resolvedPath}" for builder "${path}"`,
        );
      }

      if (
        schemaOrBuilder == null ||
        typeof schemaOrBuilder !== 'object' ||
        Array.isArray(schemaOrBuilder)
      ) {
        throw new InvalidBuilderError(
          `File "${resolvedPath}" for builder "${path}" does not contain a valid builder`,
        );
      }

      if (isBuilder(schemaOrBuilder)) {
        return [
          resolvedPath,
          {
            schema: true,
            implementation: basename(resolvedPath),
          },
        ];
      } else if (
        typeof schemaOrBuilder.type === 'string' &&
        typeof schemaOrBuilder.implementation === 'string'
      ) {
        return [
          resolvedPath,
          {
            schema: basename(resolvedPath),
            implementation: schemaOrBuilder.implementation,
          },
        ];
      } else {
        return [resolvedPath, schemaOrBuilder];
      }
    }

    throw new UnknownBuilderError(`Can't resolve builder "${path}"`);
  }

  listBuilders(packageName: string): {name: string; description?: string}[] {
    const [, builderJson, executorsJson] = this.loadBuilderJson(
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
      [builderPath, builderInfo] = await this.resolveBuilderFromPath(
        builderName,
      );
    } else {
      let builderJson, executorsJson;
      [builderPath, builderJson, executorsJson] = this.loadBuilderJson(
        packageName,
        builderSpec,
      );

      // We have to give Nx executors precedence, because nx's own plugins tend to provide a
      // fallback for the @angular/cli that fails to load snuggery.json files when looking for
      // workspace configuration
      if (
        executorsJson != null &&
        hasOwnProperty.call(executorsJson, builderName)
      ) {
        builderInfo = executorsJson[builderName]!;
        isNx = true;
      } else if (hasOwnProperty.call(builderJson, builderName)) {
        if (executorsJson != null) {
          isNx = false;
        }
        builderInfo = builderJson[builderName]!;
      } else {
        throw new UnknownBuilderError(
          `Can't find "${builderName}" in "${packageName}"`,
        );
      }
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
      return makeExecutorIntoBuilder(implementation, this.workspace);
    }

    if (!implementation[BuilderSymbol]) {
      throw new InvalidBuilderError(
        `Implementation for builder "${info.builderName}" in package "${info.packageName}" is not a builder`,
      );
    }

    return implementation;
  }

  getCurrentDirectory(): Promise<string> {
    return Promise.resolve(this.context.startCwd);
  }

  getWorkspaceRoot(): Promise<string> {
    return Promise.resolve(this.workspace?.basePath ?? this.context.startCwd);
  }

  async getOptionsForTarget(target: Target): Promise<JsonObject | null> {
    const targetDefinition = this.getTarget(target);
    const options: JsonObject = {};

    if (targetDefinition.options != null) {
      Object.assign(options, targetDefinition.options);
    }

    for (const configuration of target.configuration?.split(',') || []) {
      const configurationOptions =
        targetDefinition.configurations?.[configuration];

      if (configurationOptions == null) {
        throw new UnknownConfigurationError(
          `Target "${target.target}" in project "${target.project}" doesn't have a configuration named "${configuration}"`,
        );
      }

      Object.assign(options, configurationOptions);
    }

    return options;
  }

  getProjectMetadata(projectName: string): Promise<JsonObject>;
  getProjectMetadata(target: Target): Promise<JsonObject>;
  async getProjectMetadata(
    projectNameOrTarget: string | Target,
  ): Promise<JsonObject> {
    const projectDefinition = this.getProject(
      typeof projectNameOrTarget === 'string'
        ? projectNameOrTarget
        : projectNameOrTarget.project,
    );

    return {
      root: projectDefinition.root,
      sourceRoot: projectDefinition.sourceRoot!,
      prefix: projectDefinition.prefix!,
      ...projectDefinition.extensions,
    };
  }
}
