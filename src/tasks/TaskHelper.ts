/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ExtensionContext, QuickPickItem, Task, tasks, workspace, WorkspaceFolder } from 'vscode';
import { IActionContext } from 'vscode-azureextensionui';
import { DebugConfigurationBase } from '../debugging/DockerDebugConfigurationBase';
import { DockerDebugConfiguration } from '../debugging/DockerDebugConfigurationProvider';
import { DockerPlatform } from '../debugging/DockerPlatformHelper';
import { ext } from '../extensionVariables';
import { resolveFilePath } from '../utils/resolveFilePath';
import { DockerBuildOptions } from './DockerBuildTaskDefinitionBase';
import { DockerBuildTaskDefinition, DockerBuildTaskProvider } from './DockerBuildTaskProvider';
import { DockerPseudoShell } from './DockerPseudoShell';
import { DockerRunOptions, DockerRunTaskDefinitionBase } from './DockerRunTaskDefinitionBase';
import { DockerRunTask, DockerRunTaskDefinition, DockerRunTaskProvider } from './DockerRunTaskProvider';
import { netCoreTaskHelper } from './netcore/NetCoreTaskHelper';
import { nodeTaskHelper } from './node/NodeTaskHelper';
import { TaskDefinitionBase } from './TaskDefinitionBase';

export type DockerTaskProviderName = 'docker-build' | 'docker-run';

export interface DockerTaskContext {
    folder: WorkspaceFolder;
    platform?: DockerPlatform;
    actionContext?: IActionContext;
    cancellationToken?: CancellationToken;
}

export interface DockerTaskScaffoldContext extends DockerTaskContext {
    dockerfile: string;
}

export interface DockerTaskExecutionContext extends DockerTaskContext {
    shell: DockerPseudoShell;
}

// tslint:disable-next-line: no-empty-interface
export interface DockerBuildTaskContext extends DockerTaskExecutionContext {
    buildTaskResult?: string;
}

export interface DockerRunTaskContext extends DockerTaskExecutionContext {
    runTaskResult?: string;
    buildDefinition?: DockerBuildTaskDefinition;
}

export interface TaskHelper {
    preBuild?(context: DockerBuildTaskContext, buildDefinition: DockerBuildTaskDefinition): Promise<void>;
    getDockerBuildOptions(context: DockerBuildTaskContext, buildDefinition: DockerBuildTaskDefinition): Promise<DockerBuildOptions>;
    postBuild?(context: DockerBuildTaskContext, buildDefinition: DockerBuildTaskDefinition): Promise<void>;

    preRun?(context: DockerRunTaskContext, runDefinition: DockerRunTaskDefinition): Promise<void>;
    getDockerRunOptions(context: DockerRunTaskContext, runDefinition: DockerRunTaskDefinition): Promise<DockerRunOptions>;
    postRun?(context: DockerRunTaskContext, runDefinition: DockerRunTaskDefinition): Promise<void>;
}

export function registerTaskProviders(ctx: ExtensionContext): void {
    const helpers = {
        netCore: netCoreTaskHelper,
        node: nodeTaskHelper
    };

    ctx.subscriptions.push(
        tasks.registerTaskProvider(
            'docker-build',
            new DockerBuildTaskProvider(helpers)
        )
    );

    ctx.subscriptions.push(
        tasks.registerTaskProvider(
            'docker-run',
            new DockerRunTaskProvider(helpers)
        )
    );
}

export async function addTask(newTask: DockerBuildTaskDefinition | DockerRunTaskDefinition, overwrite: boolean | undefined): Promise<boolean> {
    // Using config API instead of tasks API means no wasted perf on re-resolving the tasks, and avoids confusion on resolved type !== true type
    const workspaceTasks = workspace.getConfiguration('tasks');
    const allTasks = workspaceTasks && workspaceTasks.tasks as TaskDefinitionBase[] || [];

    const existingTaskIndex = allTasks.findIndex(t => t.label === newTask.label);
    if (existingTaskIndex >= 0) {
        // If a task of the same label exists already
        if (overwrite) {
            // If overwriting, do so
            allTasks[existingTaskIndex] = newTask;
        } else {
            // If not overwriting, return false
            return false;
        }
    } else {
        allTasks.push(newTask);
    }

    await workspaceTasks.update('tasks', allTasks);
    return true;
}

export async function getAssociatedDockerRunTask(debugConfiguration: DockerDebugConfiguration): Promise<DockerRunTaskDefinition | undefined> {
    // Using config API instead of tasks API means no wasted perf on re-resolving the tasks, and avoids confusion on resolved type !== true type
    const workspaceTasks = workspace.getConfiguration('tasks');
    const allTasks: TaskDefinitionBase[] = workspaceTasks && workspaceTasks.tasks as TaskDefinitionBase[] || [];

    return await recursiveFindTaskByType(allTasks, 'docker-run', debugConfiguration) as DockerRunTaskDefinition;
}

export async function getAssociatedDockerBuildTask(runTask: DockerRunTask): Promise<DockerBuildTaskDefinition | undefined> {
    // Using config API instead of tasks API means no wasted perf on re-resolving the tasks, and avoids confusion on resolved type !== true type
    const workspaceTasks = workspace.getConfiguration('tasks');
    const allTasks: TaskDefinitionBase[] = workspaceTasks && workspaceTasks.tasks as TaskDefinitionBase[] || [];

    // Due to inconsistencies in the Task API, runTask does not have its dependsOn, so we need to re-find it by label
    // Due to more inconsistencies in the Task API, DockerRunTask.name is equal to the Tasks.json 'label'
    const runTaskDefinition: DockerRunTaskDefinitionBase = await findTaskByLabel(allTasks, runTask.name);

    return await recursiveFindTaskByType(allTasks, 'docker-build', runTaskDefinition) as DockerBuildTaskDefinition;
}

export async function getOfficialBuildTaskForDockerfile(dockerfile: string, folder: WorkspaceFolder): Promise<Task | undefined> {
    let buildTasks = await tasks.fetchTasks({ type: 'docker-build' });
    buildTasks =
        buildTasks.filter(t => t.execution.args.some(a => { // Find all build tasks where an argument to 'docker build' is this Dockerfile
            let arg: string;
            if (typeof a === 'string') {
                arg = a;
            } else {
                arg = a.value;
            }

            arg = resolveFilePath(arg, folder);
            return arg.toLowerCase() === dockerfile.toLowerCase();
        }));

    if (buildTasks.length === 1) {
        return buildTasks[0]; // If there's only one build task, take it
    } else if (buildTasks.length > 1) {
        const releaseTask = buildTasks.find(t => t.name === 'docker-build: release');

        if (releaseTask) {
            return releaseTask;
        }

        const items: QuickPickItem[] = buildTasks.map(t => {
            return { label: t.name }
        });

        const item = await ext.ui.showQuickPick(items, { placeHolder: 'Choose the Docker Build definition.' });
        return buildTasks.find(t => t.name === item.label);
    }

    return undefined;
}

export function inferImageName(runOptions: DockerRunTaskDefinition, context: DockerRunTaskContext, defaultNameHint: string, defaultTag?: 'dev' | 'latest'): string {
    return (runOptions && runOptions.dockerRun && runOptions.dockerRun.image)
        || (context && context.buildDefinition && context.buildDefinition.dockerBuild && context.buildDefinition.dockerBuild.tag)
        || getDefaultImageName(defaultNameHint, defaultTag);
}

export function getDefaultImageName(nameHint: string, tag?: 'dev' | 'latest'): string {
    tag = tag || 'latest';
    return getValidImageNameWithTag(nameHint, tag);
}

export function getDefaultContainerName(nameHint: string, tag?: 'dev' | 'latest'): string {
    tag = tag || 'dev';
    return `${getValidImageName(nameHint)}-${tag}`;
}

export async function recursiveFindTaskByType(allTasks: TaskDefinitionBase[], type: string, node: DebugConfigurationBase | TaskDefinitionBase): Promise<TaskDefinitionBase | undefined> {
    if (!node) {
        return undefined;
    }

    // tslint:disable: no-unsafe-any
    if (node.preLaunchTask) { // node is a debug configuration
        const next = await findTaskByLabel(allTasks, node.preLaunchTask);
        return await recursiveFindTaskByType(allTasks, type, next);
    } else if (node.type === type) { // node is the task we want
        return node;
    } else if (node.dependsOn) { // node is another task
        if (Array.isArray(node.dependsOn)) {
            for (const label of node.dependsOn as string[]) {
                let next = await findTaskByLabel(allTasks, label);
                next = await recursiveFindTaskByType(allTasks, type, next);

                if (next) {
                    return next;
                }
            }

            return undefined;
        } else {
            const nextType = node.dependsOn.type;
            const next = await findTaskByType(allTasks, nextType);
            return await recursiveFindTaskByType(allTasks, type, next);
        }
    }
    // tslint:enable: no-unsafe-any

    return undefined;
}

async function findTaskByLabel(allTasks: TaskDefinitionBase[], label: string): Promise<TaskDefinitionBase | undefined> {
    return allTasks.find(t => t.label === label);
}

async function findTaskByType(allTasks: TaskDefinitionBase[], type: string): Promise<TaskDefinitionBase | undefined> {
    return allTasks.find(t => t.type === type);
}

function getValidImageName(nameHint: string): string {
    let result = nameHint.replace(/[^a-z0-9]/gi, '').toLowerCase();

    if (result.length === 0) {
        result = 'image'
    }

    return result;
}

function getValidImageNameWithTag(nameHint: string, tag: 'dev' | 'latest'): string {
    return `${getValidImageName(nameHint)}:${tag}`
}
