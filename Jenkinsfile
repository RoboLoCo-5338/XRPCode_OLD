#!/usr/bin/env groovy

node('node.js') {
    stage('Setup') {
        git branch: "${BRANCH_NAME}",
            credentialsId: 'cccddfb1-0cc4-4006-bbc2-ef420f6d1c21',
            url: 'git@github.com:Open-STEM/FullIDE.git'

            properties([
                pipelineTriggers([pollSCM('@daily')]),
                buildDiscarder(logRotator(numToKeepStr: '20'))
            ])
    }

    if (BRANCH_NAME == 'main') {
        deployDestination = "${BRANCH_NAME}/${BUILD_NUMBER}".toString()
        buildIdentifier = "${BUILD_NUMBER}";
        baseUrl = '/'
    } else {
        deployDestination = BRANCH_NAME.toString()
        buildIdentifier = "${BRANCH_NAME}-${BUILD_NUMBER}"
        baseUrl = "/versions/${deployDestination}/".toString()
    }

    stage('Archive to S3') {
        bitbucketStatusNotify(buildState: 'INPROGRESS', buildKey: 'archive', buildName: 'Archive to S3')
        try {
            sh "aws s3 sync ./ s3://xrp-ae-250188540659-fullide/versions/${deployDestination}/ --cache-control no-cache --delete"

            bitbucketStatusNotify(buildState: 'SUCCESSFUL', buildKey: 'archive', buildName: 'Archive to S3')
        }
        catch (Throwable ex) {
            bitbucketStatusNotify(buildState: 'FAILED', buildKey: 'archive', buildName: 'Archive to S3')
            throw ex
        }
    }

    if (BRANCH_NAME == 'allogy-test') {
         stage('Deploy to Test') {
              bitbucketStatusNotify(buildState: 'INPROGRESS', buildKey: 'deploy', buildName: 'Deploy to Test')
              try {
                sh "aws s3 sync s3://xrp-ae-250188540659-fullide/versions/${deployDestination}/ s3://xrp-ae-250188540659-fullide/test/ --delete"

                bitbucketStatusNotify(buildState: 'SUCCESSFUL', buildKey: 'deploy', buildName: 'Deploy to Test')
              }
              catch (Throwable ex) {
                bitbucketStatusNotify(buildState: 'FAILED', buildKey: 'deploy', buildName: 'Deploy to Test')
                throw ex
              }
         }
    }
}
