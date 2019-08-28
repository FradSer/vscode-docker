/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ProviderResult, ShellExecution, ShellQuotedString, Task, TaskDefinition, TaskProvider, WorkspaceFolder } from 'vscode';
import { callWithTelemetryAndErrorHandling } from 'vscode-azureextensionui';
import { DockerPlatform, getPlatform } from '../debugging/DockerPlatformHelper';
import { cloneObject } from '../utils/cloneObject';
import { CommandLineBuilder } from '../utils/commandLineBuilder';
import { Platform } from '../utils/platform';
import { NetCoreTaskHelperType, NetCoreTaskOptions } from './netcore/NetCoreTaskHelper';
import { NodeTaskBuildOptions, NodeTaskHelperType } from './node/NodeTaskHelper';
import { addTask } from './TaskHelper';

export interface DockerBuildOptions {
    args?: { [key: string]: string };
    context?: string;
    dockerfile?: string;
    labels?: { [key: string]: string };
    tag?: string;
    target?: string;
    pull?: boolean;
}

export interface DockerBuildTaskDefinition extends TaskDefinition {
    label?: string;
    dependsOn?: string[];
    dockerBuild?: DockerBuildOptions;
    netCore?: NetCoreTaskOptions;
    node?: NodeTaskBuildOptions;
    platform?: DockerPlatform;
}

export interface DockerBuildTask extends Task {
    definition: DockerBuildTaskDefinition;
}

export class DockerBuildTaskProvider implements TaskProvider {
    constructor(
        private readonly netCoreTaskHelper: NetCoreTaskHelperType,
        private readonly nodeTaskHelper: NodeTaskHelperType
    ) { }

    public provideTasks(token?: CancellationToken): ProviderResult<Task[]> {
        return []; // Intentionally empty, so that resolveTask gets used
    }

    public resolveTask(task: DockerBuildTask, token?: CancellationToken): ProviderResult<Task> {
        const taskPlatform = getPlatform(task.definition);
        return callWithTelemetryAndErrorHandling(
            `docker-build/${taskPlatform || 'unknown'}`,
            async () => await this.resolveTaskInternal(task, taskPlatform, token));
    }

    // tslint:disable-next-line: no-any
    public async initializeBuildTasks(folder: WorkspaceFolder, platform: Platform, options?: any): Promise<void> {
        options = options || {};
        let buildTasks: DockerBuildTaskDefinition[];

        switch (platform) {
            case '.NET Core Console':
            case 'ASP.NET Core':
                buildTasks = await this.netCoreTaskHelper.provideDockerBuildTasks(folder, options);
                break;
            case 'Node.js':
                buildTasks = await this.nodeTaskHelper.provideDockerBuildTasks(folder, options);
                break;
            default:
                throw new Error(`The platform '${platform}' is not currently supported for Docker build tasks.`);
        }

        for (const buildTask of buildTasks) {
            await addTask(buildTask);
        }
    }

    private async resolveTaskInternal(task: DockerBuildTask, taskPlatform: DockerPlatform, token?: CancellationToken): Promise<Task> {
        const definition = cloneObject(task.definition);
        definition.dockerBuild = definition.dockerBuild || {};

        if (task.scope as WorkspaceFolder !== undefined) {
            switch (taskPlatform) {
                case 'netCore':
                    definition.dockerBuild = await this.netCoreTaskHelper.resolveDockerBuildOptions(task.scope as WorkspaceFolder, definition.dockerBuild, definition.netCore, token);
                    break;
                case 'node':
                    definition.dockerBuild = await this.nodeTaskHelper.resolveDockerBuildOptions(task.scope as WorkspaceFolder, definition.dockerBuild, definition.node, token);
                    break;
                default:
                    throw new Error(`Unrecognized platform '${definition.platform}'.`);
            }
        } else {
            throw new Error(`Unable to determine task scope to execute docker-build task '${task.name}'.`);
        }

        const commandLine = await this.resolveCommandLine(definition.dockerBuild, token);
        return new Task(
            task.definition,
            task.scope,
            task.name,
            task.source,
            new ShellExecution(commandLine[0], commandLine.slice(1)),
            task.problemMatchers);
    }

    private async resolveCommandLine(options: DockerBuildOptions, token?: CancellationToken): Promise<ShellQuotedString[]> {
        return CommandLineBuilder
            .create('docker', 'build', '--rm')
            .withFlagArg('--pull', options.pull)
            .withNamedArg('-f', options.dockerfile)
            .withKeyValueArgs('--build-arg', options.args)
            .withKeyValueArgs('--label', options.labels)
            .withNamedArg('-t', options.tag)
            .withNamedArg('--target', options.target)
            .withQuotedArg(options.context)
            .buildShellQuotedStrings();
    }
}
