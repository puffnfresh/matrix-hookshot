/* eslint-disable @typescript-eslint/ban-ts-comment */
import "reflect-metadata";
import { AdminAccountData, AdminRoomCommandHandler } from "./AdminRoomCommandHandler";
import { botCommand, compileBotCommands, handleCommand, BotCommands } from "./BotCommands";
import { BridgeConfig } from "./Config/Config";
import { BridgeRoomState, BridgeRoomStateGitHub } from "./Widgets/BridgeWidgetInterface";
import { CommandError } from "./errors";
import { Endpoints } from "@octokit/types";
import { FormatUtil } from "./FormatUtil";
import { GetUserResponse } from "./Gitlab/Types";
import { GitHubBotCommands } from "./Github/AdminCommands";
import { GithubGraphQLClient, GithubInstance } from "./Github/GithubInstance";
import { GitLabClient } from "./Gitlab/Client";
import { Intent } from "matrix-bot-sdk";
import { JiraBotCommands } from "./Jira/AdminCommands";
import { MatrixMessageContent } from "./MatrixEvent";
import { NotifFilter, NotificationFilterStateContent } from "./NotificationFilters";
import { GitHubOAuthToken, ProjectsListResponseData } from "./Github/Types";
import { UserTokenStore } from "./UserTokenStore";
import {v4 as uuid} from "uuid";
import LogWrapper from "./LogWrapper";
import markdown from "markdown-it";
type ProjectsListForRepoResponseData = Endpoints["GET /repos/{owner}/{repo}/projects"]["response"];
type ProjectsListForUserResponseData = Endpoints["GET /users/{username}/projects"]["response"];


const md = new markdown();
const log = new LogWrapper('AdminRoom');

export const LEGACY_BRIDGE_ROOM_TYPE = "uk.half-shot.matrix-github.room";
export const LEGACY_BRIDGE_NOTIF_TYPE = "uk.half-shot.matrix-github.notif_state";
export const LEGACY_BRIDGE_GITLAB_NOTIF_TYPE = "uk.half-shot.matrix-github.gitlab.notif_state";

export const BRIDGE_ROOM_TYPE = "uk.half-shot.matrix-hookshot.github.room";
export const BRIDGE_NOTIF_TYPE = "uk.half-shot.matrix-hookshot.github.notif_state";
export const BRIDGE_GITLAB_NOTIF_TYPE = "uk.half-shot.matrix-hookshot.gitlab.notif_state";
export class AdminRoom extends AdminRoomCommandHandler {
    public static helpMessage: () => MatrixMessageContent;
    protected widgetAccessToken = `abcdef`;
    static botCommands: BotCommands;

    protected pendingOAuthState: string|null = null;
    public readonly notifFilter: NotifFilter;

    constructor(roomId: string,
                data: AdminAccountData,
                notifContent: NotificationFilterStateContent,
                botIntent: Intent,
                tokenStore: UserTokenStore,
                config: BridgeConfig) {
        super(botIntent, roomId, tokenStore, config, data);
        this.notifFilter = new NotifFilter(notifContent);
        // TODO: Move this
        this.backfillAccessToken();
    }

    public get oauthState() {
        return this.pendingOAuthState;
    }

    public verifyWidgetAccessToken(token: string) {
        return this.widgetAccessToken === token;
    }

    public notificationsEnabled(type: "github"|"gitlab", instanceName?: string) {
        if (type === "github") {
            return this.data.github?.notifications?.enabled;
        }
        return (type === "gitlab" &&
            !!instanceName &&
            this.data.gitlab &&
            this.data.gitlab[instanceName].notifications.enabled
        );
    }

    public notificationsParticipating(type: "github"|"gitlab") {
        if (type !== "github") {
            return false;
        }
        return this.data.github?.notifications?.participating || false;
    }

    public clearOauthState() {
        this.pendingOAuthState = null;
    }

    public async getNotifSince(type: "github"|"gitlab", instanceName?: string) {
        if (type === "gitlab") {
            try {
                let accountData: null|{since: number} = await this.botIntent.underlyingClient.getSafeRoomAccountData(
                    `${BRIDGE_GITLAB_NOTIF_TYPE}:${instanceName}`, this.roomId, null
                );
                if (!accountData) {
                    accountData = await this.botIntent.underlyingClient.getSafeRoomAccountData(
                        `${LEGACY_BRIDGE_GITLAB_NOTIF_TYPE}:${instanceName}`, this.roomId, { since: 0 }
                    );
                }
                return accountData.since;
            } catch {
                // TODO: We should look at this error.
                return 0;
            }
        }
        try {
            let accountData: null|{since: number} = await this.botIntent.underlyingClient.getSafeRoomAccountData(BRIDGE_NOTIF_TYPE, this.roomId, { since: 0 });
            if (!accountData) {
                accountData = await this.botIntent.underlyingClient.getSafeRoomAccountData(
                    `${LEGACY_BRIDGE_NOTIF_TYPE}:${instanceName}`, this.roomId, { since: 0 }
                );
            }
            log.debug(`Got ${type} notif-since to ${accountData.since}`);
            return accountData.since;
        } catch (ex) {
            log.warn(`Filed to get ${type} notif-since`, ex);
            // TODO: We should look at this error.
            return 0;
        }
    }

    public async setNotifSince(type: "github"|"gitlab", since: number, instanceName?: string) {
        log.debug(`Updated ${type} notif-since to ${since}`);
        if (type === "gitlab") {
            return this.botIntent.underlyingClient.setRoomAccountData(
                `${BRIDGE_GITLAB_NOTIF_TYPE}:${instanceName}`,
                this.roomId, {
                since,
            });
        }
        return this.botIntent.underlyingClient.setRoomAccountData(BRIDGE_NOTIF_TYPE, this.roomId, {
            since,
        });
    }

    @botCommand("help", "This help text")
    public async helpCommand() {
        return this.botIntent.sendEvent(this.roomId, AdminRoom.helpMessage());
    }

    @botCommand("github notifications toggle", "Toggle enabling/disabling GitHub notifications in this room")
    public async setGitHubNotificationsStateToggle() {
        const newData = await this.saveAccountData((data) => {
            return {
                ...data,
                github: {
                    notifications: {
                        enabled: !(data.github?.notifications?.enabled ?? false),
                        participating: data.github?.notifications?.participating,
                    },
                },
            };
        });
        await this.sendNotice(`${newData.github?.notifications?.enabled ? "En" : "Dis"}abled GitHub notifcations`);
    }

    @botCommand("github notifications filter participating", "Toggle enabling/disabling GitHub notifications in this room")
    // @ts-ignore - property is used
    private async setGitHubNotificationsStateParticipating() {
        const newData = await this.saveAccountData((data) => {
            if (!data.github?.notifications?.enabled) {
                throw Error('Notifications are not enabled')
            }
            const oldState = data.github?.notifications?.participating ?? false;
            return {
                ...data,
                github: {
                    notifications: {
                        participating: !oldState,
                        enabled: true,
                    },
                },
            };
        });
        if (newData.github?.notifications?.participating) {
            return this.sendNotice(`Filtering for events you are participating in`);
        }
        return this.sendNotice(`Showing all events`);
    }

    @botCommand("github notifications", "Show the current notification settings")
    // @ts-ignore - property is used
    private async getGitHubNotificationsState() {
        if (!this.notificationsEnabled("github")) {
            return this.sendNotice(`Notifications are disabled`);
        }
        return this.sendNotice(`Notifications are enabled, ${this.notificationsParticipating("github") ? "Showing only events you are particiapting in" : "Showing all events"}`);
    }


    @botCommand("github project list-for-user", "List GitHub projects for a user", [], ['user', 'repo'])
    // @ts-ignore - property is used
    private async listProjects(username?: string, repo?: string) {
        if (!this.config.github) {
            return this.sendNotice("The bridge is not configured with GitHub support");
        }
        const octokit = await this.tokenStore.getOctokitForUser(this.userId);
        if (!octokit) {
            return this.sendNotice("You can not list projects without an account.");
        }

        if (!username) {
            const me = await octokit.users.getAuthenticated();
            // TODO: Fix
            username = me.data.name!;
        }

        let res: ProjectsListResponseData;
        try {
            if (repo) {
                res = (await octokit.projects.listForRepo({
                    repo,
                    owner: username,
                })).data;
            }
            res = (await octokit.projects.listForUser({
                username,
            })).data;
        } catch (ex) {
            log.warn(`Failed to fetch projects:`, ex);
            return this.sendNotice(`Failed to fetch projects due to an error. See logs for details`);
        }

        const content = `Projects for ${username}:\n${FormatUtil.projectListing(res)}\n`;
        return this.botIntent.sendEvent(this.roomId,{
            msgtype: "m.notice",
            body: content,
            formatted_body: md.render(content),
            format: "org.matrix.custom.html"
        });
    }

    @botCommand("github project list-for-org", "List GitHub projects for an org", ['org'], ['repo'])
    // @ts-ignore - property is used
    private async listProjects(org: string, repo?: string) {
        if (!this.config.github) {
            return this.sendNotice("The bridge is not configured with GitHub support");
        }
        const octokit = await this.tokenStore.getOctokitForUser(this.userId);
        if (!octokit) {
            return this.sendNotice("You can not list projects without an account.");
        }

        let res: ProjectsListForUserResponseData|ProjectsListForRepoResponseData;
        try {
            if (repo) {
                res = (await octokit.projects.listForRepo({
                    repo,
                    owner: org,
                }));
            }
            res = (await octokit.projects.listForOrg({
                org,
            }));
        } catch (ex) {
            if (ex.status === 404) {
                return this.sendNotice('Not found');
            }
            log.warn(`Failed to fetch projects:`, ex);
            return this.sendNotice(`Failed to fetch projects due to an error. See logs for details`);
        }

        const content = `Projects for ${org}:\n` + res.data.map(r => ` - ${FormatUtil.projectListing([r])}\n`).join("\n");
        return this.botIntent.sendEvent(this.roomId,{
            msgtype: "m.notice",
            body: content,
            formatted_body: md.render(content),
            format: "org.matrix.custom.html"
        });
    }

    @botCommand("github project open", "Open a GitHub project as a room", ['projectId'])
    // @ts-ignore - property is used
    private async openProject(projectId: string) {
        if (!this.config.github) {
            return this.sendNotice("The bridge is not configured with GitHub support");
        }
        const octokit = await this.tokenStore.getOctokitForUser(this.userId);
        if (!octokit) {
            return this.sendNotice("You can not list projects without an account.");
        }

        try {
            const project = await octokit.projects.get({
                project_id: parseInt(projectId, 10),
            });
            this.emit('open.project', project.data);
        } catch (ex) {
            if (ex.status === 404) {
                return this.sendNotice('Not found');
            }
            log.warn(`Failed to fetch project:`, ex);
            return this.sendNotice(`Failed to fetch project due to an error. See logs for details`);
        }
    }

    @botCommand("github discussion open", "Open a discussion room", ['owner', 'repo', 'number'])
    // @ts-ignore - property is used
    private async listDiscussions(owner: string, repo: string, numberStr: string) {
        const number = parseInt(numberStr);
        if (!this.config.github) {
            return this.sendNotice("The bridge is not configured with GitHub support");
        }
        const octokit = await this.tokenStore.getOctokitForUser(this.userId);
        if (!octokit) {
            return this.sendNotice("You can not list projects without an account.");
        }
        try {
            const graphql = new GithubGraphQLClient(octokit);
            const discussions = await graphql.getDiscussionByNumber(owner, repo, number);
            this.emit('open.discussion', owner, repo, discussions);
        } catch (ex) {
            if (ex.status === 404) {
                return this.sendNotice('Not found');
            }
            log.warn(`Failed to fetch discussions:`, ex);
            return this.sendNotice(`Failed to fetch discussions due to an error. See logs for details`);
        }

    }

    /* GitLab commands */

    @botCommand("gitlab open issue", "Open or join a issue room for GitLab", ['url'])
    // @ts-ignore - property is used
    private async gitLabOpenIssue(url: string) {
        if (!this.config.gitlab) {
            return this.sendNotice("The bridge is not configured with GitLab support");
        }

        const urlResult = GitLabClient.splitUrlIntoParts(this.config.gitlab.instances, url);
        if (!urlResult) {
            return this.sendNotice("The URL was not understood. The URL must be an issue and the bridge must know of the GitLab instance.");
        }
        const [instanceName, parts] = urlResult;
        const instance = this.config.gitlab.instances[instanceName];
        const client = await this.tokenStore.getGitLabForUser(this.userId, instance.url);
        if (!client) {
            return this.sendNotice("You have not added a personal access token for GitLab");
        }
        const getIssueOpts = {
            issue: parseInt(parts[parts.length-1]),
            projects: parts.slice(0, parts.length-3), // Remove - and /issues
        };
        log.info(`Looking up issue ${instanceName} ${getIssueOpts.projects.join("/")}#${getIssueOpts.issue}`);
        const issue = await client.issues.get(getIssueOpts);
        this.emit('open.gitlab-issue', getIssueOpts, issue, instanceName, instance);
    }

    @botCommand("gitlab personaltoken", "Set your personal access token for GitLab", ['instanceName', 'accessToken'])
    public async setGitLabPersonalAccessToken(instanceName: string, accessToken: string) {
        let me: GetUserResponse;
        if (!this.config.gitlab) {
            return this.sendNotice("The bridge is not configured with GitLab support");
        }
        const instance = this.config.gitlab.instances[instanceName];
        if (!instance) {
            return this.sendNotice("The bridge is not configured for this GitLab instance");
        }
        try {
            const client = new GitLabClient(instance.url, accessToken);
            me = await client.user();
            client.issues
        } catch (ex) {
            log.error("Gitlab auth error:", ex);
            return this.sendNotice("Could not authenticate with GitLab. Is your token correct?");
        }
        await this.sendNotice(`Connected as ${me.username}. Token stored`);
        return this.tokenStore.storeUserToken("gitlab", this.userId, accessToken, instance.url);
    }

    @botCommand("gitlab hastoken", "Check if you have a token stored for GitLab", ["instanceName"])
    public async gitlabHasPersonalToken(instanceName: string) {
        if (!this.config.gitlab) {
            return this.sendNotice("The bridge is not configured with GitLab support");
        }
        const instance = this.config.gitlab.instances[instanceName];
        if (!instance) {
            return this.sendNotice("The bridge is not configured for this GitLab instance");
        }
        const result = await this.tokenStore.getUserToken("gitlab", this.userId, instance.url);
        if (result === null) {
            return this.sendNotice("You do not currently have a token stored");
        }
        return this.sendNotice("A token is stored for your GitLab account.");
    }

    @botCommand("gitlab notifications toggle", "Toggle enabling/disabling GitHub notifications in this room", ["instanceName"])
    public async setGitLabNotificationsStateToggle(instanceName: string) {
        if (!this.config.gitlab) {
            return this.sendNotice("The bridge is not configured with GitLab support");
        }
        const instance = this.config.gitlab.instances[instanceName];
        if (!instance) {
            return this.sendNotice("The bridge is not configured for this GitLab instance");
        }
        const hasClient = await this.tokenStore.getGitLabForUser(this.userId, instance.url);
        if (!hasClient) {
            return this.sendNotice("You do not have a GitLab token configured for this instance");
        }
        let newValue = false;
        await this.saveAccountData((data) => {
            const currentNotifs = (data.gitlab || {})[instanceName].notifications;
            newValue = !currentNotifs.enabled;
            return {
                ...data,
                gitlab: {
                    [instanceName]: {
                        notifications: {
                            enabled: newValue,
                        },
                    }
                },
            };
        });
        return this.sendNotice(`${newValue ? "En" : "Dis"}abled GitLab notifications for ${instanceName}`);
    }

    @botCommand("filters list", "List your saved filters")
    public async getFilters() {
        if (this.notifFilter.empty) {
            return this.sendNotice("You do not currently have any filters");
        }
        const filterText = Object.entries(this.notifFilter.filters).map(([name, value]) => {
            const userText = value.users.length ? `users: ${value.users.join("|")}` : '';
            const reposText = value.repos.length ? `users: ${value.repos.join("|")}` : '';
            const orgsText = value.orgs.length ? `users: ${value.orgs.join("|")}` : '';
            return `${name}: ${userText} ${reposText} ${orgsText}`
        }).join("\n");
        const enabledForInvites = [...this.notifFilter.forInvites].join(', ');
        const enabledForNotifications = [...this.notifFilter.forNotifications].join(', ');
        return this.sendNotice(`Your filters:\n ${filterText}\nEnabled for automatic room invites: ${enabledForInvites}\nEnabled for notifications: ${enabledForNotifications}`);
    }

    @botCommand("filters set", "Create (or update) a filter. You can use 'orgs:', 'users:' or 'repos:' as filter parameters.", ["name", "...parameters"])
    public async setFilter(name: string, ...parameters: string[]) {
        const orgs = parameters.filter(param => param.toLowerCase().startsWith("orgs:")).map(param => param.toLowerCase().substring("orgs:".length).split(",")).flat();
        const users = parameters.filter(param => param.toLowerCase().startsWith("users:")).map(param => param.toLowerCase().substring("users:".length).split(",")).flat();
        const repos = parameters.filter(param => param.toLowerCase().startsWith("repos:")).map(param => param.toLowerCase().substring("repos:".length).split(",")).flat();
        if (orgs.length + users.length + repos.length === 0) {
            return this.sendNotice("You must specify some filter options like 'orgs:matrix-org,half-shot', 'users:Half-Shot' or 'repos:matrix-hookshot'");
        }
        this.notifFilter.setFilter(name, {
            orgs,
            users,
            repos,
        });
        await this.botIntent.underlyingClient.sendStateEvent(this.roomId, NotifFilter.StateType, "", this.notifFilter.getStateContent());
        return this.sendNotice(`Stored new filter "${name}". You can now apply the filter by saying 'filters notifications toggle $name'`);
    }

    @botCommand("filters notifications toggle", "Apply a filter as a whitelist to your notifications", ["name"])
    public async setFiltersNotificationsToggle(name: string) {
        if (!this.notifFilter.filters[name]) {
            return this.sendNotice(`Filter "${name}" doesn't exist'`);
        }
        if (this.notifFilter.forNotifications.has(name)) {
            this.notifFilter.forNotifications.delete(name);
            await this.sendNotice(`Filter "${name}" disabled for notifications`);
        } else {
            this.notifFilter.forNotifications.add(name);
            await this.sendNotice(`Filter "${name}" enabled for notifications`);
        }
        return this.botIntent.underlyingClient.sendStateEvent(this.roomId, NotifFilter.StateType, "", this.notifFilter.getStateContent());
    }

    private async saveAccountData(updateFn: (record: AdminAccountData) => AdminAccountData) {
        let oldData: AdminAccountData|null = await this.botIntent.underlyingClient.getSafeRoomAccountData(BRIDGE_ROOM_TYPE, this.roomId, null);
        if (!oldData) {
            oldData = await this.botIntent.underlyingClient.getSafeRoomAccountData(LEGACY_BRIDGE_ROOM_TYPE, this.roomId, {admin_user: this.userId});
        }
        const newData = updateFn(oldData);
        await this.botIntent.underlyingClient.setRoomAccountData(BRIDGE_ROOM_TYPE, this.roomId, newData);
        this.emit("settings.changed", this, oldData, newData);
        this.data = newData;
        return newData;
    }

    public async handleCommand(eventId: string, command: string) {
        const result = await handleCommand(this.userId, command, AdminRoom.botCommands, this);
        if (!result.handled) {
            return this.sendNotice("Command not understood");
        }
        
        if ("error" in result) {
            return this.sendNotice(`Failed to handle command: ${result.error}`);
        }
        return null;
    }

    public async getBridgeState(): Promise<BridgeRoomState> {
        const gitHubEnabled = !!this.config.github;
        const github: BridgeRoomStateGitHub = {
            enabled: false,
            tokenStored: false,
            identity: null,
            notifications: false,
        };
        if (gitHubEnabled) {
            const octokit = await this.tokenStore.getOctokitForUser(this.userId);
            try {
                const identity = await octokit?.users.getAuthenticated();
                github.enabled = true;
                github.tokenStored = !!octokit;
                github.identity = {
                    name: identity?.data.login || null,
                    avatarUrl: identity?.data.avatar_url || null,
                };
                github.notifications = this.notificationsEnabled("github") || false;
            } catch (ex) {
                log.warn(`Failed to get user identity: ${ex}`);
            }
        }
        
        return {
            title: "Admin Room",
            github,
        }
    }

    public async setupWidget() {
        try {
            const res = await this.botIntent.underlyingClient.getRoomStateEvent(this.roomId, "im.vector.modular.widgets", "bridge_control");
            if (res) {
                // No-op
                // Validate?
                return;
            }
        } catch (ex) {
            // Didn't exist, create it.
        }
        const accessToken = uuid();
        return this.botIntent.underlyingClient.sendStateEvent(
            this.roomId,
            "im.vector.modular.widgets",
            "bridge_control",
            {
                "creatorUserId": this.botIntent.userId,
                "data": {
                  "title": "Bridge Control"
                },
                "id": "bridge_control",
                "name": "Bridge Control",
                "type": "m.custom",
                "url": `${this.config.widgets?.publicUrl}/#/?roomId=$matrix_room_id&widgetId=$matrix_widget_id&accessToken=${accessToken}`,
                accessToken,
                "waitForIframeLoad": true
            }
        );
    }

    private async backfillAccessToken() {
        try {
            const res = await this.botIntent.underlyingClient.getRoomStateEvent(this.roomId, "im.vector.modular.widgets", "bridge_control");
            if (res) {
                log.debug(`Stored access token for widgets for ${this.roomId}`);
                this.widgetAccessToken = res.accessToken;
            }
        } catch (ex) {
            log.info(`No widget access token for ${this.roomId}`);
        }
    }

    public toString() {
        return `AdminRoom(${this.roomId}, ${this.userId})`;
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res = compileBotCommands(AdminRoom.prototype as any, GitHubBotCommands.prototype as any, JiraBotCommands.prototype as any);
AdminRoom.helpMessage = res.helpMessage;
AdminRoom.botCommands = res.botCommands;
