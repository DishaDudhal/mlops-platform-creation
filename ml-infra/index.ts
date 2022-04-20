import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as random from "@pulumi/random";
import * as k8s from '@pulumi/kubernetes';
import S3ServiceAccount from "./S3ServiceAccount";
import TraefikRoute from './TraefikRoute';

// Create an EKS cluster with the default configuration.
const cluster = new eks.Cluster("ml-cluster", {
    createOidcProvider: true,
});

//Create a random passowrd to access DB
const mlflowDBPassword = new random.RandomPassword("mlflow-db-password", {
    length: 16,
    special: false,
});

//Add a Namespace to the EKS cluster
const mlflowNamespace = new k8s.core.v1.Namespace('mlflow-namespace', {
    metadata: { name: 'mlflow' },
  }, { provider: cluster.provider });

// Install Traefik
const traefik = new k8s.helm.v3.Chart('traefik', {
    chart: 'traefik',
    fetchOpts: { repo: 'https://helm.traefik.io/traefik'},
  }, { provider: cluster.provider })
  

//Create Postgres DB instance
const mlflowDB = new aws.rds.Instance("mlflow-db", {
    allocatedStorage: 10,
    engine: "postgres",
    engineVersion: "11.15",
    instanceClass: "db.t3.micro",
    name: "mlflow",
    password: mlflowDBPassword.result,
    skipFinalSnapshot: true,
    username: "postgres", 

    //Make sure that Kubernetes is able to acces this DB
    vpcSecurityGroupIds: [cluster.clusterSecurityGroup.id, cluster.nodeSecurityGroup.id]
});

// Create S3 bucket for MLFlow
const artifactStorage = new aws.s3.Bucket("artifact-storage", {
    acl: "public-read-write",
  });

//Creating a USER/ service account so that mlflow can talk to s3
const mlflowServiceAccount = new S3ServiceAccount('mlflow-service-account', {
    namespace: mlflowNamespace.metadata.name,
    oidcProvider: cluster.core.oidcProvider!,
    readOnly: false,
  }, { provider: cluster.provider });

//
const mlflow = new k8s.helm.v3.Chart("mlflow", {
    chart: "mlflow",
    namespace: mlflowNamespace.metadata.name,
    values: {
      "backendStore": {
        "postgres": {
          "username": mlflowDB.username,
          "password": mlflowDB.password,
          "host": mlflowDB.address,
          "port": mlflowDB.port,
          "database": "mlflow"
        }
      },
      "defaultArtifactRoot": artifactStorage.bucket.apply((bucketName: string) => `s3://${bucketName}`),
      "serviceAccount": {
        "create": false,
        "name": mlflowServiceAccount.name,
      }
    },
    fetchOpts: { repo: "https://larribas.me/helm-charts" },
  }, { provider: cluster.provider });


new TraefikRoute('mlflow', {
    prefix: '/mlflow',
    service: mlflow.getResource('v1/Service', 'mlflow', 'mlflow'),
    namespace: mlflowNamespace.metadata.name,
  }, { provider: cluster.provider});
  

  new aws.route53.Record("dns-record", {
    zoneId: "Z05229193D9XZSES18BQQ",
    name: "ml.dishasmita.com",
    type: "CNAME",
    ttl: 300,
   records: [traefik.getResource('v1/Service', 'traefik').status.loadBalancer.ingress[0].hostname],
 });

 console.log("$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$");
 console.log(traefik.getResource('v1/Service', 'traefik').status.loadBalancer.ingress[0].hostname);
 console.log("$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$");


// Export the cluster's kubeconfig.
export const kubeconfig = cluster.kubeconfig;