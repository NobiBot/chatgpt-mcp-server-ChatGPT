import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { DockerService } from '../services/docker.service.js';
import { ConfigService } from '../services/config.service.js';

const SHUTDOWN_TIMEOUT = 5000; // 5 seconds
const SSE_STREAM_PATH = '/sse';
const SSE_MESSAGE_PATH = '/message';
const HEALTH_PATH = '/health';

export class McpServer {
  private server: Server;
  private dockerService: DockerService;
  private config: ConfigService;
  private requestCount: number = 0;
  private lastRequestTime: number = Date.now();
  private transport: StdioServerTransport | SSEServerTransport | null = null;
  private activeRequests = new Set<Promise<any>>();
  private isShuttingDown = false;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private sseTransport: SSEServerTransport | null = null;
  private httpHost: string | null = null;
  private httpPort: number | null = null;

  constructor(dockerService: DockerService) {
    this.dockerService = dockerService;
    this.config = ConfigService.getInstance();
    this.server = new Server(
      {
        name: 'docker-assistant-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupTools();
    this.setupErrorHandling();
  }

  private checkRateLimit(): void {
    if (this.isShuttingDown) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Server is shutting down'
      );
    }

    const now = Date.now();
    if (now - this.lastRequestTime > this.config.rateLimitWindow) {
      this.requestCount = 0;
      this.lastRequestTime = now;
    }

    this.requestCount++;
    if (this.requestCount > this.config.rateLimitRequests) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Rate limit exceeded. Please try again later.'
      );
    }
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    // Handle transport errors
    process.on('error', (error) => {
      console.error('[Transport Error]', error);
      this.stop().catch(console.error);
    });
  }

  private async wrapRequest<T>(request: Promise<T>): Promise<T> {
    this.activeRequests.add(request);
    try {
      return await request;
    } finally {
      this.activeRequests.delete(request);
    }
  }

  private setupTools(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'containers_list',
          description: 'List all Docker containers',
          inputSchema: {
            type: 'object',
            properties: {
              all: {
                type: 'boolean',
                description: 'Show all containers (including stopped ones)',
              },
            },
          },
        },
        {
          name: 'container_create',
          description: 'Create and start a new Docker container',
          inputSchema: {
            type: 'object',
            properties: {
              image: {
                type: 'string',
                description: 'Docker image name',
              },
              name: {
                type: 'string',
                description: 'Container name',
              },
              ports: {
                type: 'array',
                items: { type: 'string' },
                description: 'Port mappings (e.g. ["80:80"])',
              },
              env: {
                type: 'array',
                items: { type: 'string' },
                description: 'Environment variables (e.g. ["KEY=value"])',
              },
            },
            required: ['image'],
          },
        },
        {
          name: 'container_stop',
          description: 'Stop a running container',
          inputSchema: {
            type: 'object',
            properties: {
              container: {
                type: 'string',
                description: 'Container ID or name',
              },
            },
            required: ['container'],
          },
        },
        {
          name: 'container_start',
          description: 'Start a stopped container',
          inputSchema: {
            type: 'object',
            properties: {
              container: {
                type: 'string',
                description: 'Container ID or name',
              },
            },
            required: ['container'],
          },
        },
        {
          name: 'container_remove',
          description: 'Remove a container',
          inputSchema: {
            type: 'object',
            properties: {
              container: {
                type: 'string',
                description: 'Container ID or name',
              },
              force: {
                type: 'boolean',
                description: 'Force remove running container',
              },
            },
            required: ['container'],
          },
        },
        {
          name: 'container_logs',
          description: 'Get container logs',
          inputSchema: {
            type: 'object',
            properties: {
              container: {
                type: 'string',
                description: 'Container ID or name',
              },
              tail: {
                type: 'number',
                description: 'Number of lines to show from the end',
              },
            },
            required: ['container'],
          },
        },
        {
          name: 'container_exec',
          description: 'Execute a command in a running container',
          inputSchema: {
            type: 'object',
            properties: {
              container: {
                type: 'string',
                description: 'Container ID or name',
              },
              command: {
                type: 'string',
                description: 'Command to execute',
              },
            },
            required: ['container', 'command'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.checkRateLimit();

      const toolRequest = (async () => {
        try {
          const args = request.params.arguments ?? {};

          switch (request.params.name) {
            case 'containers_list': {
              const { all } = args as { all?: boolean };
              const output = await this.dockerService.listContainers(all);
              return {
                content: [{ type: 'text', text: output }],
              };
            }

            case 'container_create': {
              const { image, name, ports, env } = args as {
                image: string;
                name?: string;
                ports?: string[];
                env?: string[];
              };

              const output = await this.dockerService.createContainer({
                image,
                name,
                ports,
                env,
              });
              return {
                content: [{ type: 'text', text: `Container created: ${output}` }],
              };
            }

            case 'container_stop': {
              const { container } = args as { container: string };
              const output = await this.dockerService.stopContainer(container);
              return {
                content: [{ type: 'text', text: `Container stopped: ${output}` }],
              };
            }

            case 'container_start': {
              const { container } = args as { container: string };
              const output = await this.dockerService.startContainer(container);
              return {
                content: [{ type: 'text', text: `Container started: ${output}` }],
              };
            }

            case 'container_remove': {
              const { container, force } = args as {
                container: string;
                force?: boolean;
              };
              const output = await this.dockerService.removeContainer(container, force);
              return {
                content: [{ type: 'text', text: `Container removed: ${output}` }],
              };
            }

            case 'container_logs': {
              const { container, tail } = args as {
                container: string;
                tail?: number;
              };
              const output = await this.dockerService.getContainerLogs(container, tail);
              return {
                content: [{ type: 'text', text: output }],
              };
            }

            case 'container_exec': {
              const { container, command } = args as {
                container: string;
                command: string;
              };
              const output = await this.dockerService.execInContainer(container, command);
              return {
                content: [{ type: 'text', text: output }],
              };
            }

            default:
              throw new McpError(
                ErrorCode.MethodNotFound,
                `Unknown tool: ${request.params.name}`
              );
          }
        } catch (error) {
          if (error instanceof McpError) {
            throw error;
          }
          throw new McpError(
            ErrorCode.InternalError,
            `Error executing Docker command: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })();

      return this.wrapRequest(toolRequest);
    });
  }

  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }

  private extractApiKey(req: IncomingMessage): string | null {
    const header = req.headers['x-api-key'];
    if (Array.isArray(header)) {
      return header[0] ?? null;
    }
    return typeof header === 'string' ? header : null;
  }

  private isAuthorized(req: IncomingMessage): boolean {
    return this.extractApiKey(req) === this.config.apiKey;
  }

  private async handleSseHandshake(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.isShuttingDown) {
      res.writeHead(503).end('Server is shutting down');
      return;
    }

    if (!this.isAuthorized(req)) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    if (this.transport) {
      try {
        await this.server.close();
      } catch (error) {
        console.error('Error closing existing transport before new SSE connection:', error);
      }
      this.transport = null;
      this.sseTransport = null;
    }

    const transport = new SSEServerTransport(SSE_MESSAGE_PATH, res);
    this.transport = transport;
    this.sseTransport = transport;

    transport.onclose = () => {
      this.transport = null;
      this.sseTransport = null;
    };

    transport.onerror = (error) => {
      console.error('[SSE Transport Error]', error);
    };

    this.setCorsHeaders(res);

    try {
      await this.server.connect(transport);
    } catch (error) {
      console.error('Failed to establish SSE connection:', error);
      if (!res.headersSent) {
        res.writeHead(500).end('Failed to establish SSE connection');
      }
      this.transport = null;
      this.sseTransport = null;
    }
  }

  private async handleSseMessage(req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<void> {
    if (!this.isAuthorized(req)) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    const sessionId = requestUrl.searchParams.get('sessionId');
    if (!sessionId || !this.sseTransport || this.sseTransport.sessionId !== sessionId) {
      res.writeHead(404).end('Session not found');
      return;
    }

    this.setCorsHeaders(res);

    try {
      await this.sseTransport.handlePostMessage(req, res);
    } catch (error) {
      console.error('Error handling SSE message:', error);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error');
      }
    }
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!req.url) {
        res.writeHead(404).end('Not Found');
        return;
      }

      const hostHeader = req.headers.host ?? `${this.httpHost ?? 'localhost'}:${this.httpPort ?? 0}`;
      const requestUrl = new URL(req.url, `http://${hostHeader}`);

      if (req.method === 'OPTIONS') {
        this.setCorsHeaders(res);
        res.writeHead(204).end();
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === HEALTH_PATH) {
        this.setCorsHeaders(res);
        res.writeHead(200).end('ok');
        return;
      }

      if (req.method === 'GET' && requestUrl.pathname === SSE_STREAM_PATH) {
        await this.handleSseHandshake(req, res);
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === SSE_MESSAGE_PATH) {
        await this.handleSseMessage(req, res, requestUrl);
        return;
      }

      this.setCorsHeaders(res);
      res.writeHead(404).end('Not Found');
    } catch (error) {
      console.error('HTTP request handling error:', error);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error');
      }
    }
  }

  async start(): Promise<void> {
    try {
      this.isShuttingDown = false;
      const useHttp =
        (process.env.MCP_TRANSPORT ?? '').toLowerCase() === 'http' ||
        !!process.env.HTTP_PORT;

      if (useHttp) {
        const port = parseInt(process.env.HTTP_PORT ?? '3001', 10);
        const host = process.env.HTTP_HOST ?? '0.0.0.0';
        this.httpHost = host;
        this.httpPort = port;

        this.httpServer = createServer((req, res) => {
          this.handleHttpRequest(req, res).catch((error) => {
            console.error('Unhandled error in HTTP request handler:', error);
            if (!res.headersSent) {
              res.writeHead(500).end('Internal Server Error');
            }
          });
        });

        await new Promise<void>((resolve, reject) => {
          if (!this.httpServer) {
            reject(new Error('HTTP server not initialized'));
            return;
          }

          this.httpServer.once('error', reject);
          this.httpServer.listen(port, host, () => {
            this.httpServer?.off('error', reject);
            resolve();
          });
        });

        console.log(`MCP server (HTTP/SSE) listening at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${SSE_STREAM_PATH}`);
        return;
      }

      this.transport = new StdioServerTransport();
      await this.server.connect(this.transport);
      console.log('MCP server running on stdio');
    } catch (error) {
      console.error('Failed to start MCP server:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    return new Promise<void>(async (resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        console.warn('MCP server shutdown timeout reached');
        resolve();
      }, SHUTDOWN_TIMEOUT);

      try {
        if (this.activeRequests.size > 0) {
          console.log(`Waiting for ${this.activeRequests.size} active requests to complete...`);
          await Promise.race([
            Promise.all(this.activeRequests),
            new Promise(r => setTimeout(r, SHUTDOWN_TIMEOUT))
          ]);
        }

        if (this.transport) {
          await this.server.close();
          this.transport = null;
          this.sseTransport = null;
        }

        if (this.httpServer) {
          await new Promise<void>((httpResolve, httpReject) => {
            this.httpServer?.close((err) => {
              if (err) {
                httpReject(err);
              } else {
                httpResolve();
              }
            });
          });
          this.httpServer = null;
          this.httpHost = null;
          this.httpPort = null;
        }

        clearTimeout(timeoutHandle);
        resolve();
      } catch (error) {
        clearTimeout(timeoutHandle);
        console.error('Error during MCP server shutdown:', error);
        reject(error);
      }
    });
  }
}
