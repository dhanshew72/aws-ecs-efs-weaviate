import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';


export class AwsEcsEfsWeaviateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const defaultVPC = ec2.Vpc.fromLookup(this, "ImportVPC", {
      vpcName: "Default VPC",
      vpcId: ""
    });

    const primarySubnet = ec2.Subnet.fromSubnetAttributes(this, 'PrimarySubnet', {subnetId: "", availabilityZone: "us-east-1b"})
    const secondarySubnet = ec2.Subnet.fromSubnetAttributes(this, 'SecondarySubnet', {subnetId: "", availabilityZone: "us-east-1c"})

    const cluster = new ecs.Cluster(this, 'LLMCluster', {
      clusterName: "weaviate-cluster",
      vpc: defaultVPC
    });
    const fsSecurityGroup = new ec2.SecurityGroup(this, "WeaviateEFSSG", {
      vpc: defaultVPC,
      allowAllOutbound: true,
    });
    fsSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(defaultVPC.vpcCidrBlock),
      ec2.Port.tcp(2049)
    );
    const weaviatePersistDb = new efs.FileSystem(this, 'WeaviatePersistDB', {
      fileSystemName: `weaviate-persist-db`,
      vpc: defaultVPC,
      securityGroup: fsSecurityGroup,
      vpcSubnets: {
          subnets: [primarySubnet, secondarySubnet]
      },
      throughputMode: efs.ThroughputMode.ELASTIC,
    });
    const node0AccessPoint = new efs.AccessPoint(this, 'AccessPoint', {
      fileSystem: weaviatePersistDb,
      path: "/data/node0",
      createAcl: {
        ownerGid: '1001',
        ownerUid: '1001',
        permissions: '750',
      },
      posixUser: {
        uid: '1001',
        gid: '1001',
      },
    });
    const volNode0Name = "weaviate-node0-efs"
    const weaviateTaskDefinition = new ecs.FargateTaskDefinition(this, 'WeaviateNode0TaskDefinition', {
      cpu: 2048,
      memoryLimitMiB: 16384,
      volumes: [
          {
              name: volNode0Name,
              efsVolumeConfiguration: {
                  fileSystemId: weaviatePersistDb.fileSystemId,
                  transitEncryption: 'ENABLED',
                  authorizationConfig: {
                      accessPointId: node0AccessPoint.accessPointId,
                      iam: 'ENABLED',
                  }
              }
          }
      ]
    });
    weaviateTaskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
          actions: [
            'elasticfilesystem:ClientMount',
            'elasticfilesystem:ClientWrite',
            'elasticfilesystem:ClientRootAccess'
          ],
          resources: [weaviatePersistDb.fileSystemArn],
      })
    );
    const weaviateNamespace = new servicediscovery.PrivateDnsNamespace(this, 'LLMServiceDiscovery', {
      name: `weaviate.local`,
      vpc: defaultVPC,
    });
    let grpcPort = 50051;
    let httpPort = 8080;
    let gossipPort = 7100;
    let dataBindPort = 7101;
    const weaviateSecurityGroup = new ec2.SecurityGroup(this, 'WeaviateSecurityGroup', {
      vpc: defaultVPC,
      description: 'Security group for the weaviate alb',
      // Identical to 0.0.0.0/0 with ip protocol -1
      allowAllOutbound: true
    });
    weaviateSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(defaultVPC.vpcCidrBlock), 
      ec2.Port.tcp(grpcPort), 
      'Allow inbound gRPC traffic'
    );
    weaviateSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(defaultVPC.vpcCidrBlock), 
      ec2.Port.tcp(httpPort), 
      'Allow inbound HTTP traffic'
    );
    const weaviateNode0 = new ecs.FargateService(this, 'WeaviateNode0Service', {
      serviceName: `weaviate-node0`,
      cluster: cluster,
      taskDefinition: weaviateTaskDefinition,
      desiredCount: 1,
      enableECSManagedTags: false,
      maxHealthyPercent: 200,
      minHealthyPercent: 0,
      // Allows pulling of public images (weaviate from docker hub)
      assignPublicIp: true,
      cloudMapOptions: { 
          name: `weaviate-node0`, 
          cloudMapNamespace: weaviateNamespace 
      },
      securityGroups: [weaviateSecurityGroup],
      vpcSubnets: {
          subnets: [primarySubnet, secondarySubnet]
      }
    });
    let volumePath = "/data";
    let weaviateVersion = "1.24.21";
    const weaviateEnvironment = {
      "LOG_LEVEL": "warning",
      "QUERY_DEFAULTS_LIMIT": "25",
      "AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED": 'true',
      "DEFAULT_VECTORIZER_MODULE": 'none',
      "ENABLE_MODULES": 'backup-s3',
      "PERSISTENCE_DATA_PATH": volumePath,
      "HNSW_STARTUP_WAIT_FOR_VECTOR_CACHE": "true"
    };
    const weaviateNode0LogGroup = new logs.LogGroup(this, 'WeaviateNode0LogGroup');
    const weaviateNode0Container = weaviateTaskDefinition.addContainer("WeaviateNode0Container", {
      cpu: 2048,
      memoryLimitMiB: 16384,
      containerName: 'WeaviateNode0',
      image: ecs.ContainerImage.fromRegistry(`semitechnologies/weaviate:${weaviateVersion}`),
      command: [
          "--host",
          "0.0.0.0",
          "--port",
          `${httpPort.toString()}`,
          "--scheme",
          "http"
      ],
      environment: {
          ...weaviateEnvironment,
          // Hostname is required, otherwise it uses an elastic IP which changes per container spin up
          "CLUSTER_HOSTNAME": "node0",
          "CLUSTER_GOSSIP_BIND_PORT": `${gossipPort}`,
          "CLUSTER_DATA_BIND_PORT": `${dataBindPort}`,
      },
      logging: ecs.LogDriver.awsLogs({
          streamPrefix: 'ecs',
          logGroup: weaviateNode0LogGroup,
      }),
      portMappings: [
          {
              containerPort: httpPort,
              hostPort: httpPort,
              protocol: ecs.Protocol.TCP
          }, 
          {
              containerPort: grpcPort,
              hostPort: grpcPort,
              protocol: ecs.Protocol.TCP
          },
          {
              containerPort: gossipPort,
              hostPort: gossipPort,
              protocol: ecs.Protocol.TCP
          },
          {
              containerPort: dataBindPort,
              hostPort: dataBindPort,
              protocol: ecs.Protocol.TCP
          },
      ]
    });
    weaviateNode0Container.addMountPoints(
      {
          containerPath:  volumePath,
          sourceVolume: volNode0Name,
          readOnly: false
      }  
    );
    weaviateNode0.node.addDependency(weaviateNamespace);
    this.addNodes(
      defaultVPC, 
      cluster, 
      volumePath, 
      weaviatePersistDb, 
      httpPort, 
      grpcPort, 
      gossipPort, 
      dataBindPort, 
      primarySubnet, 
      secondarySubnet, 
      weaviateSecurityGroup, 
      weaviateNode0, 
      weaviateEnvironment
    );
  }
  private addNodes(
    defaultVPC: ec2.IVpc, 
    cluster: ecs.Cluster, 
    volumePath: string,
    efsFileSystem: efs.IFileSystem, 
    httpPort: number,
    grpcPort: number,
    gossipPort: number,
    dataBindPort: number,
    primarySubnet: ec2.ISubnet,
    secondarySubnet: ec2.ISubnet,
    weaviateSecurityGroup: ec2.SecurityGroup,
    weaviateNode0: ecs.FargateService,
    weaviateEnvironment: any,
) {
    // Change this maximum value for number of nodes requested
    for (let node = 1; node <= 2; node++) {
        const nodeAccessPoint = new efs.AccessPoint(this, `AccessNode${node}Point`, {
            fileSystem: efsFileSystem,
            path: `/data/node${node}`,
            createAcl: {
              ownerGid: '1001',
              ownerUid: '1001',
              permissions: '750',
            },
            posixUser: {
              uid: '1001',
              gid: '1001',
            },
        });
        const volNodeName = `weaviate-node${node}-efs`
        const weaviateTaskDefinition = new ecs.FargateTaskDefinition(this, `WeaviateNode${node}TaskDefinition`, {
            cpu: 2048,
            memoryLimitMiB: 16384,
            volumes: [
                {
                    name: volNodeName,
                    efsVolumeConfiguration: {
                        fileSystemId: efsFileSystem.fileSystemId,
                        transitEncryption: 'ENABLED',
                        authorizationConfig: {
                            accessPointId: nodeAccessPoint.accessPointId,
                            iam: 'ENABLED',
                        }
                    }
                }
            ]
        });
        const nodeLogGroup = new logs.LogGroup(this, `WeaviateNode${node}LogGroup`);
        const nodeContainer = weaviateTaskDefinition.addContainer(`WeaviateNode${node}Container`, {
            cpu: 2048,
            memoryLimitMiB: 16384,
            containerName: `WeaviateNode${node}`,
            image: ecs.ContainerImage.fromRegistry(`semitechnologies/weaviate:1.24.21`),
            command: [
                "--host",
                "0.0.0.0",
                "--port",
                `${httpPort.toString()}`,
                "--scheme",
                "http"
            ],
            environment: {
                ...weaviateEnvironment,
                "CLUSTER_HOSTNAME": `node${node}`,
                "CLUSTER_GOSSIP_BIND_PORT": `${gossipPort + node}`,
                "CLUSTER_DATA_BIND_PORT": `${dataBindPort + node}`,
                "CLUSTER_JOIN": `weaviate-node0.local:${gossipPort}`
            },
            logging: ecs.LogDriver.awsLogs({
                streamPrefix: 'ecs',
                logGroup: nodeLogGroup,
            }),
            portMappings: [
                {
                    containerPort: httpPort + node,
                    hostPort: httpPort + node,
                    protocol: ecs.Protocol.TCP
                }, 
                {
                    containerPort: grpcPort + node,
                    hostPort: grpcPort + node,
                    protocol: ecs.Protocol.TCP
                },
                {
                    hostPort: gossipPort + node,
                    containerPort: gossipPort + node,
                    protocol: ecs.Protocol.TCP
                },
                {
                    hostPort: dataBindPort + node,
                    containerPort: dataBindPort + node,
                    protocol: ecs.Protocol.TCP
                },
            ]
        });
        weaviateSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(defaultVPC.vpcCidrBlock),
            ec2.Port.tcp(httpPort + node)
        );
        weaviateSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(defaultVPC.vpcCidrBlock),
            ec2.Port.tcp(grpcPort + node)
        );
        weaviateSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(defaultVPC.vpcCidrBlock),
            ec2.Port.tcp(gossipPort + node)
        );
        weaviateSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(defaultVPC.vpcCidrBlock),
            ec2.Port.tcp(dataBindPort + node)
        );
        nodeContainer.addMountPoints(
            {
                containerPath:  volumePath,
                sourceVolume: volNodeName,
                readOnly: false
            }
        );
        weaviateTaskDefinition.addToTaskRolePolicy(
            new iam.PolicyStatement({
                actions: [
                'elasticfilesystem:ClientMount',
                'elasticfilesystem:ClientWrite',
                'elasticfilesystem:ClientRootAccess'
                ],
                resources: [efsFileSystem.fileSystemArn],
            })
        );
        const weaviateNode = new ecs.FargateService(this, `WeaviateNode${node}Service`, {
            serviceName: `weaviate-node${node}`,
            cluster: cluster,
            taskDefinition: weaviateTaskDefinition,
            desiredCount: 1,
            enableECSManagedTags: false,
            maxHealthyPercent: 200,
            minHealthyPercent: 0,
            // Allows pulling of public images (weaviate from docker hub)
            assignPublicIp: true,
            securityGroups: [weaviateSecurityGroup],
            vpcSubnets: {
                subnets: [primarySubnet, secondarySubnet]
            }
        });
        // Required to deploy the first node then this one for joining the cluster. Otherwise this node just fails and sits there, menacingly.
        weaviateNode.node.addDependency(weaviateNode0);
    }
  }
}
