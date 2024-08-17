#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsEcsEfsWeaviateStack } from '../lib/aws-ecs-efs-weaviate-stack';

const app = new cdk.App();
new AwsEcsEfsWeaviateStack(app, 'AwsEcsEfsWeaviateStack', {});
