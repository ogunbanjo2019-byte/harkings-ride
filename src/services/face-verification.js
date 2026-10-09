import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { env } from '../config/env.js';

let clientOverride;
let client;

export const setRekognitionClientForTests = (value) => {
  clientOverride = value;
};

export const getRekognitionClient = () => {
  if (clientOverride) return clientOverride;

  if (!env.awsRegion) {
    throw new Error('AWS_REGION must be configured for AWS Rekognition face verification.');
  }
  
  if (Boolean(env.awsAccessKeyId) !== Boolean(env.awsSecretAccessKey)) {
    throw new Error('Configure both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
  }

  const credentials = env.awsAccessKeyId ? {
    accessKeyId: env.awsAccessKeyId,
    secretAccessKey: env.awsSecretAccessKey,
    ...(env.awsSessionToken ? { sessionToken: env.awsSessionToken } : {}),
  } : undefined;

  client ||= new RekognitionClient({
    region: env.awsRegion,
    ...(credentials ? { credentials } : {}),
  });

  return client;
};

export const createLivenessSession = async (clientRequestToken) => {
  const result = await getRekognitionClient().send(
    new CreateFaceLivenessSessionCommand({
      ClientRequestToken: clientRequestToken,
      Settings: {
        AuditImagesLimit: 0,
        ChallengePreferences: [{ Type: 'FaceMovementAndLightChallenge' }],
      },
    })
  );

  if (!result.SessionId) {
    throw new Error('AWS Rekognition did not return a liveness session ID.');
  }

  return result.SessionId;
};

export const getLivenessResults = async (sessionId) => 
  getRekognitionClient().send(
    new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId })
  );

export const compareLivenessFaceToDocument = async ({ livenessReferenceBytes, documentBytes }) => {
  const result = await getRekognitionClient().send(
    new CompareFacesCommand({
      SourceImage: { Bytes: livenessReferenceBytes },
      TargetImage: { Bytes: documentBytes },
      SimilarityThreshold: env.faceMatchSimilarityThreshold,
      QualityFilter: 'AUTO',
    })
  );

  const similarity = Math.max(
    0, 
    ...(result.FaceMatches || []).map((match) => Number(match.Similarity || 0))
  );

  return {
    similarity,
    matched: similarity >= env.faceMatchSimilarityThreshold,
  };
};