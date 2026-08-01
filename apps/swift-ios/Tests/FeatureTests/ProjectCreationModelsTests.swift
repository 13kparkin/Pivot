import Foundation
import Testing
@testable import T3Code

@Suite("Native project creation")
struct ProjectCreationModelsTests {
    @Test
    func repositoryNamesCoverHttpsSshAndProviderPaths() {
        #expect(
            ProjectCreationPath.repositoryName(
                from: "https://github.com/pingdotgg/t3code.git"
            ) == "t3code"
        )
        #expect(
            ProjectCreationPath.repositoryName(
                from: "git@github.com:pingdotgg/t3code.git"
            ) == "t3code"
        )
        #expect(ProjectCreationPath.repositoryName(from: "pingdotgg/t3code") == "t3code")
        #expect(ProjectCreationPath.repositoryName(from: "") == "repository")
    }

    @Test
    func pathsRequireServerAbsoluteOrHomeRelativeInput() throws {
        #expect(try ProjectCreationPath.validated(" ~/work/t3code ").get() == "~/work/t3code")
        #expect(try ProjectCreationPath.validated("/srv/t3code").get() == "/srv/t3code")
        #expect(try ProjectCreationPath.validated(#"C:\work\t3code"#).get() == #"C:\work\t3code"#)
        #expect(ProjectCreationPath.validated("relative/project").isFailure)
        #expect(ProjectCreationPath.validated("  ").isFailure)
    }

    @Test
    func destinationSuggestionsRespectUnixAndWindowsSeparators() {
        #expect(ProjectCreationPath.appending("t3code", to: "~/work") == "~/work/t3code")
        #expect(ProjectCreationPath.appending("t3code", to: "~/work/") == "~/work/t3code")
        #expect(
            ProjectCreationPath.appending("t3code", to: #"C:\work"#) == #"C:\work\t3code"#
        )
        #expect(
            ProjectCreationPath.normalizedForComparison(#"C:\Work\T3Code\"#)
                == "c:/work/t3code"
        )
    }

    @Test
    func discoveryKeepsGitUrlReadyAndGatesProviderAuthentication() {
        let discovery = SourceControlDiscoveryResult(
            versionControlSystems: [],
            sourceControlProviders: [
                SourceControlProviderDiscoveryItem(
                    kind: .github,
                    label: "GitHub",
                    status: .available,
                    version: "2.76",
                    installHint: "Install gh",
                    auth: SourceControlProviderAuth(
                        status: .authenticated,
                        account: "octocat"
                    )
                ),
                SourceControlProviderDiscoveryItem(
                    kind: .gitlab,
                    label: "GitLab",
                    status: .available,
                    installHint: "Install glab",
                    auth: SourceControlProviderAuth(
                        status: .unauthenticated,
                        detail: "Run glab auth login"
                    )
                ),
            ]
        )

        let options = ProjectRemoteSourceOptions.options(discovery: discovery)
        let bySource = Dictionary(uniqueKeysWithValues: options.map { ($0.source, $0) })

        #expect(bySource[.url]?.isReady == true)
        #expect(bySource[.github]?.isReady == true)
        #expect(bySource[.github]?.detail == "Signed in as octocat")
        #expect(bySource[.gitlab]?.isReady == false)
        #expect(bySource[.gitlab]?.detail == "Run glab auth login")
        #expect(bySource[.bitbucket]?.isReady == false)
    }
}

private extension Result {
    var isFailure: Bool {
        if case .failure = self { return true }
        return false
    }
}
