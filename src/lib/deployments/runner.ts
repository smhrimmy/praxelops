import { DeploymentWorkflow, DeploymentStep } from "@/types/deployment";
import { StorageService } from "@/lib/storage";
import { SSHAdapter } from "@/lib/ssh/adapter";

export class DeploymentRunner {
  static async runWorkflow(workflow: DeploymentWorkflow): Promise<DeploymentWorkflow> {
    const server = StorageService.getServerById(workflow.serverId);
    if (!server) {
      workflow.status = "failed";
      StorageService.saveDeployment(workflow);
      return workflow;
    }

    workflow.status = "in_progress";
    StorageService.saveDeployment(workflow);

    StorageService.logAuditEvent({
      actor: "operator",
      eventType: "deployment_triggered",
      targetServerId: server.id,
      targetServerName: server.name,
      status: "success",
      details: {
        workflowId: workflow.id,
        name: workflow.name,
        environment: workflow.environment,
      },
    });

    let hasFailed = false;

    for (const step of workflow.steps) {
      step.status = "running";
      step.startedAt = new Date().toISOString();
      StorageService.saveDeployment(workflow);

      try {
        const fullCmd = `cd ${workflow.appDirectory} && ${step.command}`;
        const res = await SSHAdapter.executeCommand(server, fullCmd);

        step.finishedAt = new Date().toISOString();
        step.exitCode = res.code;
        step.outputLog = res.stdout || res.stderr;

        if (res.code === 0) {
          step.status = "success";
        } else {
          step.status = "failed";
          hasFailed = true;
          break;
        }
      } catch (err) {
        step.status = "failed";
        step.outputLog = `Execution error: ${(err as Error).message}`;
        hasFailed = true;
        break;
      }
    }

    if (hasFailed) {
      workflow.status = "failed";
    } else {
      workflow.status = "healthy";
      workflow.completedAt = new Date().toISOString();
    }

    StorageService.saveDeployment(workflow);
    return workflow;
  }

  static async rollback(workflow: DeploymentWorkflow): Promise<DeploymentWorkflow> {
    if (!workflow.rollbackCommand) return workflow;
    const server = StorageService.getServerById(workflow.serverId);
    if (!server) return workflow;

    const res = await SSHAdapter.executeCommand(
      server,
      `cd ${workflow.appDirectory} && ${workflow.rollbackCommand}`
    );

    workflow.status = "rolled_back";
    StorageService.saveDeployment(workflow);

    StorageService.logAuditEvent({
      actor: "operator",
      eventType: "deployment_rollback",
      targetServerId: server.id,
      targetServerName: server.name,
      status: res.code === 0 ? "success" : "failure",
      details: { workflowId: workflow.id, rollbackCommand: workflow.rollbackCommand },
    });

    return workflow;
  }
}
