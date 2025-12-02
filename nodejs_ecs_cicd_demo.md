# Demo Node.js app + AWS CI/CD (GitHub -> CodeBuild (unit tests) -> CodeDeploy to ECS)

This document contains a ready-to-use demo Node.js static web app and all the CI/CD artifacts needed to deploy it to Amazon ECS using an AWS CodePipeline that pulls from GitHub, runs unit tests in CodeBuild, builds a Docker image, and deploys to ECS using CodeDeploy (ECS blue/green). Use this as a starting point — adjust ARNs, names, VPC/subnet IDs, and IAM roles for your environment.

---

## Project structure

```
nodejs-ecs-cicd-demo/
├─ app/
│  ├─ server.js
│  ├─ package.json
│  └─ public/
│     └─ index.html
├─ Dockerfile
├─ .dockerignore
├─ buildspec.yml            # CodeBuild buildspec
├─ appspec.yaml             # CodeDeploy AppSpec for ECS
├─ taskdef.json             # ECS task definition used by CodeDeploy
└─ cloudformation/
   └─ pipeline.yaml         # (example) CloudFormation to create pipeline components (optional)
```

---

## 1) Minimal Node.js app

**app/server.js**

```js
const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({status: 'ok'}));

app.listen(port, () => console.log(`Demo app listening on ${port}`));
```

**app/package.json**

```json
{
  "name": "demo-static-node",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "jest --runInBand"
  },
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "jest": "^29.0.0",
    "supertest": "^6.3.0"
  }
}
```

**app/public/index.html**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>NodeJS ECS CI/CD Demo</title>
  </head>
  <body>
    <h1>Node.js ECS CI/CD Demo</h1>
    <p>This is a static demo page served by Express.</p>
  </body>
</html>
```

Add a simple unit test to validate `/health`:

**app/__tests__/health.test.js**

```js
const request = require('supertest');
const express = require('express');
const path = require('path');

// create a small instance of the app for testing
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

test('GET /health returns status ok', async () => {
  const res = await request(app).get('/health');
  expect(res.statusCode).toBe(200);
  expect(res.body.status).toBe('ok');
});
```

---

## 2) Dockerfile

**Dockerfile**

```Dockerfile
FROM node:20-alpine
WORKDIR /usr/src/app
COPY app/package*.json ./
RUN npm ci --production
COPY app/ ./
EXPOSE 8080
CMD ["node", "server.js"]
```

**.dockerignore**

```
node_modules
npm-debug.log
.git
```

Notes: using `npm ci --production` is typical for build images in pipeline. If tests run in CodeBuild before docker build, keep devDependencies only in build environment.

---

## 3) CodeBuild `buildspec.yml`

This `buildspec.yml` performs install, unit tests, builds Docker image, logs in to ECR (you must create an ECR repo and provide ECR login details via environment variables or role), pushes image, and generates taskdef.json used by CodeDeploy.

**buildspec.yml**

```yaml
version: 0.2
env:
  variables:
    IMAGE_REPO_NAME: demo-nodejs
    IMAGE_TAG: "${CODEBUILD_RESOLVED_SOURCE_VERSION}"
phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - echo Installing dependencies
      - cd app
      - npm ci
      - cd ..
  pre_build:
    commands:
      - echo Logging in to Amazon ECR
      - aws --version
      - $(aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com)
      - REPO_URI=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$IMAGE_REPO_NAME
      - echo REPO_URI=$REPO_URI
  build:
    commands:
      - echo Running unit tests
      - cd app && npm test || { echo 'Tests failed'; exit 1; }
      - cd ..
      - echo Building Docker image
      - docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .
      - docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $REPO_URI:$IMAGE_TAG
  post_build:
    commands:
      - echo Pushing Docker image to ECR
      - docker push $REPO_URI:$IMAGE_TAG
      - printf '[{"name":"containerName","imageUri":"%s"}]' $REPO_URI:$IMAGE_TAG > imagedefinitions.json
artifacts:
  files:
    - imagedefinitions.json
```

**Important environment variables** (configure in CodeBuild Project or provided by CodePipeline):
- `AWS_REGION` (e.g. `ap-south-1`)
- `AWS_ACCOUNT_ID`
- `IMAGE_REPO_NAME` can be set in env or left as default

`imagedefinitions.json` is the artifact consumed by CodeDeploy/ECS deployment actions.

---

## 4) AppSpec and Task Definition (for CodeDeploy ECS blue/green)

**appspec.yaml**

```yaml
version: 0.0
Resources:
  - TargetService:
      Type: AWS::ECS::Service
      Properties:
        TaskDefinition: "<TASK_DEF_PLACEHOLDER>"
        LoadBalancerInfo:
          ContainerName: containerName
          ContainerPort: 8080
```

This `appspec.yaml` is minimal. For CodeDeploy you'll generally provide the task definition JSON separately and CodeDeploy will swap to new deployment.

**taskdef.json** (example skeleton)

```json
{
  "family": "demo-nodejs-task",
  "networkMode": "awsvpc",
  "containerDefinitions": [
    {
      "name": "containerName",
      "image": "REPLACEME_IMAGE_URI",
      "portMappings": [{ "containerPort": 8080, "protocol": "tcp" }],
      "essential": true
    }
  ],
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::AWS_ACCOUNT_ID:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::AWS_ACCOUNT_ID:role/ecsTaskRole"
}
```

At deployment time you replace `REPLACEME_IMAGE_URI` with the ECR image URI (the CodeBuild `imagedefinitions.json` artifact plus CodeDeploy will take care of this if using the ECS deployment action). If using CodeDeploy, the pipeline action will register a new task definition revision with the new image.

---

## 5) CodePipeline (high-level)

1. **Source**: GitHub repository (connect via OAuth or GitHub App). On push to `main` (or configured branch) pipeline triggers.
2. **Build**: AWS CodeBuild project uses the repository and `buildspec.yml`. It runs tests, builds image, pushes to ECR, and emits `imagedefinitions.json` artifact.
3. **Deploy**: AWS CodeDeploy/ECS deploy action picks `imagedefinitions.json` and deploys to ECS Service configured for blue/green (requires AppSpec and target ECS service created beforehand). CodeDeploy will update the ECS service to new task definition and swap traffic via Application Load Balancer.

You can create CodePipeline using CloudFormation, the AWS Console, or the AWS CLI. Below is a minimal CloudFormation snippet (conceptual) showing the pipeline resource - adapt names, role ARNs, and action configs.

> **Note**: Creating an ECS Service with CodeDeploy blue/green requires an Application Load Balancer with target groups (two target groups for blue/green switching) and the ECS service configured to use CodeDeploy as deployment controller.

---

## 6) IAM & AWS resources (summary checklist)

- ECR repository `demo-nodejs` (create ahead or let pipeline create)
- ECS Cluster (Fargate) and Task Execution Role (`ecsTaskExecutionRole`) with `AmazonECSTaskExecutionRolePolicy`.
- ECS Task Role for application if necessary.
- ECS Service with deploymentController `CODE_DEPLOY` and associated ALB + two target groups (primary & test) as required by CodeDeploy blue/green.
- CodeDeploy Application (ECS) and Deployment Group configured for the ECS service, ALB, and target groups.
- CodeBuild service role with permissions to: access ECR, push images, write artifacts to S3, assume CodeBuild actions, and access Secrets Manager if you store secrets.
- CodePipeline service role with permissions to invoke CodeBuild, CodeDeploy, read source artifact, and read S3.

---

## 7) Quick manual steps (console-based)

1. Create ECR repo `demo-nodejs`.
2. Create ECS cluster (Fargate) and the `demo-nodejs` service (initially pointed to a simple task definition using any image or the same `public` image). Configure ALB and listeners and two target groups required by CodeDeploy.
3. Create CodeDeploy Application (ECS) and Deployment Group linking to the ECS service and ALB target groups.
4. Create CodeBuild project with the provided `buildspec.yml` and environment variables: `AWS_REGION`, `AWS_ACCOUNT_ID`, optionally `IMAGE_REPO_NAME`.
5. Create CodePipeline: Source (GitHub) -> Build (CodeBuild) -> Deploy (CodeDeploy ECS). Set artifact store (S3) and use the CodePipeline role.
6. Push the repository to GitHub; pipeline should trigger. CodeBuild runs tests; if tests pass, image is built/pushed and CodeDeploy will deploy to ECS.

---

## 8) Helpful tips and troubleshooting

- **Unit tests failing**: Ensure `jest` and `supertest` are installed as devDependencies; CodeBuild install phase uses `npm ci` in `app/`.
- **ECR login fails in CodeBuild**: confirm CodeBuild role has `ecr:GetAuthorizationToken` and `ecr:BatchCheckLayerAvailability`, `ecr:CompleteLayerUpload`, etc.
- **CodeDeploy failing**: verify the ECS service uses `CODE_DEPLOY` deployment controller, the target groups and ALB are configured per CodeDeploy requirements.
- **Task definition/roles**: execution role must have `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `logs:CreateLogStream`, `logs:PutLogEvents`, and appropriate ECS permissions.

---



